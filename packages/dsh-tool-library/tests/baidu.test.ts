/**
 * 百度网盘适配器测试（设计文档 1.8.6 / 2.5）。
 *
 * 用模拟 fetcher 验证三步分片上传协议的调用顺序、参数与错误处理，
 * 不触网。
 *
 * @module dsh-tool-library/__tests__/baidu
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BaiduProvider, type BaiduConfig } from '../src/remote.js';

const CONFIG: BaiduConfig = { accessToken: 'token-abc', appName: 'ebook' };

interface Recorded {
  url: string;
  init: RequestInit | undefined;
}

/** 构造一个按顺序返回预设响应的 fetcher。 */
function makeFetcher(responses: { status: number; body?: unknown }[]): {
  fetcher: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let index = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const spec = responses[index] ?? { status: 200, body: {} };
    index += 1;
    return new Response(spec.body === undefined ? '' : JSON.stringify(spec.body), {
      status: spec.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetcher, calls };
}

function withTempFile(content: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'baidu-'));
  const path = join(dir, 'video.mp4');
  writeFileSync(path, content);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('BaiduProvider 分片上传', () => {
  it('按 precreate → 分片 → create 三步执行', async () => {
    const { path, cleanup } = withTempFile('x'.repeat(100));
    try {
      // precreate 返回 uploadid，create 返回成功
      const { fetcher, calls } = makeFetcher([
        { status: 200, body: { uploadid: 'UP-123', return_type: 1 } },
        { status: 200, body: {} }, // 分片 1
        { status: 200, body: { return_type: 2 } }, // create 成功
      ]);
      const provider = new BaiduProvider(CONFIG, fetcher);
      await provider.uploadFile(path, '/apps/ebook/video.mp4');

      expect(calls).toHaveLength(3);
      // 1. precreate
      expect(calls[0]?.url).toContain('method=precreate');
      const preBody = calls[0]?.init?.body as URLSearchParams;
      expect(preBody.get('path')).toBe('/apps/ebook/video.mp4');
      expect(preBody.get('size')).toBe('100');
      const blockList = JSON.parse(preBody.get('block_list') as string) as string[];
      expect(blockList).toHaveLength(1);
      expect(blockList[0]).toMatch(/^[0-9a-f]{32}$/); // md5

      // 2. 分片上传
      expect(calls[1]?.url).toContain('superfile2');
      expect(calls[1]?.url).toContain('uploadid=UP-123');
      // partseq 在 multipart body 里，不在 URL 上
      const partForm = calls[1]?.init?.body as FormData;
      expect(partForm.get('partseq')).toBe('0');
      expect(calls[1]?.init?.method).toBe('POST');

      // 3. create
      expect(calls[2]?.url).toContain('method=create');
      const createBody = calls[2]?.init?.body as URLSearchParams;
      expect(createBody.get('uploadid')).toBe('UP-123');
    } finally {
      cleanup();
    }
  });

  it('超过 4 MiB 时切成多片', async () => {
    // 9 MiB → 3 片（4+4+1）
    const content = 'y'.repeat(9 * 1024 * 1024);
    const { path, cleanup } = withTempFile(content);
    try {
      const { fetcher, calls } = makeFetcher([
        { status: 200, body: { uploadid: 'UP-9M' } },
        { status: 200, body: {} },
        { status: 200, body: {} },
        { status: 200, body: {} },
        { status: 200, body: { return_type: 2 } },
      ]);
      const provider = new BaiduProvider(CONFIG, fetcher);
      await provider.uploadFile(path, '/apps/ebook/big.mp4');

      // 1 precreate + 3 分片 + 1 create
      expect(calls).toHaveLength(5);
      const preBody = calls[0]?.init?.body as URLSearchParams;
      const blockList = JSON.parse(preBody.get('block_list') as string) as string[];
      expect(blockList).toHaveLength(3);
    } finally {
      cleanup();
    }
  });

  it('precreate 失败时抛出可读错误', async () => {
    const { path, cleanup } = withTempFile('x');
    try {
      const { fetcher } = makeFetcher([{ status: 401, body: { error: 'auth' } }]);
      const provider = new BaiduProvider(CONFIG, fetcher);
      await expect(provider.uploadFile(path, '/apps/ebook/a.mp4')).rejects.toThrow(/precreate 失败：HTTP 401/);
    } finally {
      cleanup();
    }
  });

  it('precreate 未返回 uploadid 时报错', async () => {
    const { path, cleanup } = withTempFile('x');
    try {
      const { fetcher } = makeFetcher([{ status: 200, body: { return_type: 1 } }]);
      const provider = new BaiduProvider(CONFIG, fetcher);
      await expect(provider.uploadFile(path, '/apps/ebook/a.mp4')).rejects.toThrow(/未返回 uploadid/);
    } finally {
      cleanup();
    }
  });

  it('分片上传失败时中止，不执行 create', async () => {
    const { path, cleanup } = withTempFile('x'.repeat(10));
    try {
      const { fetcher, calls } = makeFetcher([
        { status: 200, body: { uploadid: 'UP-X' } },
        { status: 500, body: {} }, // 分片失败
        { status: 200, body: {} },
      ]);
      const provider = new BaiduProvider(CONFIG, fetcher);
      await expect(provider.uploadFile(path, '/apps/ebook/a.mp4')).rejects.toThrow(/分片 0 上传失败/);
      // 只调用了 precreate 和第一个分片
      expect(calls).toHaveLength(2);
      expect(calls.some((c) => c.url.includes('method=create'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('create 返回 return_type=1 视为失败', async () => {
    const { path, cleanup } = withTempFile('x');
    try {
      const { fetcher } = makeFetcher([
        { status: 200, body: { uploadid: 'UP-Y' } },
        { status: 200, body: {} },
        { status: 200, body: { return_type: 1 } }, // 失败
      ]);
      const provider = new BaiduProvider(CONFIG, fetcher);
      await expect(provider.uploadFile(path, '/apps/ebook/a.mp4')).rejects.toThrow(/create 合并失败/);
    } finally {
      cleanup();
    }
  });

  it('文件名含中文时正确编码', async () => {
    const { path, cleanup } = withTempFile('x');
    try {
      const { fetcher, calls } = makeFetcher([
        { status: 200, body: { uploadid: 'UP-ZH' } },
        { status: 200, body: {} },
        { status: 200, body: { return_type: 2 } },
      ]);
      const provider = new BaiduProvider(CONFIG, fetcher);
      await provider.uploadFile(path, '/apps/ebook/黑暗森林解析.mp4');
      // path 在 URL 里被编码，不会出现裸中文
      expect(calls[1]?.url).not.toContain('黑暗森林');
      expect(calls[1]?.url).toContain('%E9%BB%91');
    } finally {
      cleanup();
    }
  });
});

describe('BaiduProvider 其它能力', () => {
  it('listFiles 解析返回结构', async () => {
    const { fetcher } = makeFetcher([
      {
        status: 200,
        body: {
          list: [
            { path: '/apps/ebook/a.mp4', isdir: 0, size: 1024, server_mtime: 1790000000 },
            { path: '/apps/ebook/sub', isdir: 1, size: 0, server_mtime: 1790000000 },
          ],
        },
      },
    ]);
    const provider = new BaiduProvider(CONFIG, fetcher);
    const files = await provider.listFiles('/apps/ebook');
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ path: '/apps/ebook/a.mp4', isDirectory: false, sizeBytes: 1024 });
    expect(files[1]?.isDirectory).toBe(true);
  });

  it('authenticate 成功后 isConnected 为 true', async () => {
    const { fetcher } = makeFetcher([{ status: 200, body: { list: [] } }]);
    const provider = new BaiduProvider(CONFIG, fetcher);
    expect(provider.isConnected()).toBe(false);
    await provider.authenticate();
    expect(provider.isConnected()).toBe(true);
  });
});
