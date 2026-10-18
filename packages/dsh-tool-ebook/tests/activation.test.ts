/**
 * 插件激活测试：用真实的 `defineTool` + 模拟的 `ctx.tools` 注册表，
 * 验证每个插件的 apply() 真的把工具注册进去，并且输出 schema 合法。
 *
 * 这比"模块能 import"强得多：它验证了 apply() 的完整执行路径。
 *
 * @module dsh-tool-ebook/__tests__/activation
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { defineTool } from '@deepseek-ai/dsh-tools';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';

/** 模拟 dsh 的 ToolRuntime。 */
class FakeToolRegistry {
  readonly registered = new Map<string, unknown>();

  register(definition: unknown): void {
    const tool = definition as { name: string };
    this.registered.set(tool.name, definition);
  }
}

/** 模拟 Cordis Context。 */
function makeContext(registry: FakeToolRegistry) {
  return {
    tools: registry,
    fs: {
      resolve: async (path: string) => path,
      stat: async () => ({ type: 'file', size: 1 }),
      lstat: async () => ({ type: 'file' }),
    },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  };
}

/** 校验一个已注册工具的输出 schema 能被真实值通过。 */
function validateOutput(tool: unknown, value: unknown): string[] {
  const t = tool as { output: { schema: object } };
  try {
    validateJsonSchemaValue(t.output.schema, value);
    return [];
  } catch (error) {
    return [(error as Error).message];
  }
}

describe('dsh-tool-ebook 激活', () => {
  let registry: FakeToolRegistry;

  beforeEach(() => {
    registry = new FakeToolRegistry();
  });

  it('注册 open_ebook 与 convert_and_open', async () => {
    const plugin = await import('../src/index.js');
    plugin.apply(makeContext(registry), { readerBaseUrl: 'http://127.0.0.1:5173', libraryRoot: '' });
    expect([...registry.registered.keys()].sort()).toEqual(['convert_and_open', 'open_ebook']);
  });

  it('工具输出 schema 校验真实的返回值', async () => {
    const plugin = await import('../src/index.js');
    plugin.apply(makeContext(registry), { readerBaseUrl: 'http://127.0.0.1:5173', libraryRoot: '' });
    const openEbook = registry.registered.get('open_ebook') as {
      execute: (args: unknown, exec: unknown) => Promise<unknown>;
    };
    const result = (await openEbook.execute(
      { bookPath: 'books/三体/三体.epub' },
      { agent: { session: { header: { cwd: '/workspace' } } }, signal: new AbortController().signal },
    )) as Record<string, never>;
    expect(validateOutput(openEbook, result)).toEqual([]);
    expect(result.instruction.url).toContain('127.0.0.1:5173');
  });

  it('buildReaderUrl / buildLibraryUrl / isDirectlyRenderable / defaultTargetFormat', async () => {
    const plugin = await import('../src/index.js');
    // URL 查询参数顺序由 URLSearchParams 决定，这里只断言语义
    const url = new URL(plugin.buildReaderUrl('http://x/', { bookPath: '/a.epub', page: 'library' }));
    expect(url.origin + url.pathname).toBe('http://x/');
    expect(url.searchParams.get('book')).toBe('/a.epub');
    expect(url.hash).toBe('#library');
    const libUrl = new URL(plugin.buildLibraryUrl('http://x/', '/lib'));
    expect(libUrl.searchParams.get('library')).toBe('/lib');
    expect(libUrl.hash).toBe('#library');
    expect(plugin.isDirectlyRenderable('a.epub')).toBe(true);
    expect(plugin.isDirectlyRenderable('a.mobi')).toBe(false);
    expect(plugin.defaultTargetFormat('mobi')).toBe('epub');
    expect(plugin.defaultTargetFormat('djvu')).toBe('pdf');
  });
});

describe('dsh-tool-wiki 激活', () => {
  it('注册五个 wiki 工具', async () => {
    const registry = new FakeToolRegistry();
    const plugin = await import('../../dsh-tool-wiki/src/index.js');
    plugin.apply(makeContext(registry), { wikiBaseUrl: 'http://127.0.0.1:5174', libraryRoot: '/tmp/nonexistent', localMode: true });
    expect([...registry.registered.keys()].sort()).toEqual([
      'open_wiki',
      'wiki_create_page',
      'wiki_graph',
      'wiki_mcp_status',
      'wiki_search',
    ]);
  });
});

describe('dsh-tool-password 激活', () => {
  it('注册 open_password_vault', async () => {
    const registry = new FakeToolRegistry();
    const plugin = await import('../../dsh-tool-password/src/index.js');
    plugin.apply(makeContext(registry), { vaultBaseUrl: 'http://127.0.0.1:8787', probeTimeoutMs: 100 });
    expect([...registry.registered.keys()]).toEqual(['open_password_vault']);
  });
});

describe('dsh-tool-convert 激活', () => {
  it('注册两个转换工具', async () => {
    const registry = new FakeToolRegistry();
    const plugin = await import('../../dsh-tool-convert/src/index.js');
    plugin.apply(makeContext(registry), { pandocCommand: 'pandoc', ddjvuCommand: 'ddjvu', timeoutMs: 1000 });
    expect([...registry.registered.keys()].sort()).toEqual(['convert_djvu_to_pdf', 'convert_markdown_to_docx']);
  });

  it('planConversion / detectConversion 纯函数', async () => {
    const plugin = await import('../../dsh-tool-convert/src/index.js');
    expect(plugin.detectConversion('a.md', 'b.docx')).toBe('markdown-to-docx');
    expect(plugin.detectConversion('a.djvu', 'b.pdf')).toBe('djvu-to-pdf');
    expect(() => plugin.detectConversion('a.md', 'b.pdf')).toThrow();
    const plan = plugin.planConversion('/in/a.md', '/out/b.docx', { pandocCommand: 'pandoc', ddjvuCommand: 'ddjvu' });
    expect(plan.command).toBe('pandoc');
    expect(plan.args).toEqual(['/in/a.md', '-o', '/out/b.docx']);
  });
});

describe('dsh-tool-translate 激活', () => {
  it('注册 translate_text', async () => {
    const registry = new FakeToolRegistry();
    const plugin = await import('../../dsh-tool-translate/src/index.js');
    plugin.apply(makeContext(registry), { defaultTargetLang: 'zh', maxChars: 100, timeoutMs: 1000 });
    expect([...registry.registered.keys()]).toEqual(['translate_text']);
  });

  it('buildTranslatePrompt 包含目标语言与上下文', async () => {
    const plugin = await import('../../dsh-tool-translate/src/index.js');
    const prompt = plugin.buildTranslatePrompt({ targetLang: 'zh', sourceLang: 'en', context: '《三体》第一章' });
    expect(prompt).toContain('简体中文');
    expect(prompt).toContain('英语');
    expect(prompt).toContain('《三体》第一章');
    expect(plugin.languageName('ja')).toBe('日语');
  });
});

describe('dsh-tool-library 激活', () => {
  it('注册四个图书馆工具', async () => {
    const registry = new FakeToolRegistry();
    const plugin = await import('../../dsh-tool-library/src/index.js');
    plugin.apply(makeContext(registry), {
      libraryBaseUrl: 'http://127.0.0.1:5173',
      libraryRoot: '',
      clientId: 'test',
      clientType: 'dsh-extension',
      clientPlatform: 'macos',
    });
    expect([...registry.registered.keys()].sort()).toEqual([
      'add_remote_source',
      'import_from_remote',
      'open_library',
      'sync_library',
    ]);
  });

  it('未配置 libraryRoot 时工具给出可读错误', async () => {
    const registry = new FakeToolRegistry();
    const plugin = await import('../../dsh-tool-library/src/index.js');
    plugin.apply(makeContext(registry), {
      libraryBaseUrl: 'http://x',
      libraryRoot: '',
      clientId: 'test',
      clientType: 'dsh-extension',
      clientPlatform: 'macos',
    });
    const openLibrary = registry.registered.get('open_library') as { execute: () => Promise<unknown> };
    await expect(openLibrary.execute({}, { signal: new AbortController().signal })).rejects.toThrow(/libraryRoot/);
  });

  it('choosePullStrategy 选择正确的路径', async () => {
    const plugin = await import('../../dsh-tool-library/src/index.js');
    expect(plugin.choosePullStrategy({ sameProvider: true, providerId: 'webdav', sameAccount: true })).toBe('remote-copy');
    expect(plugin.choosePullStrategy({ sameProvider: true, providerId: 'baidu', sameAccount: true })).toBe('download-then-upload');
    expect(plugin.choosePullStrategy({ sameProvider: false, providerId: 'webdav', sameAccount: false })).toBe('download-then-upload');
  });

  it('parseWebDavMultistatus 解析条目', async () => {
    const plugin = await import('../../dsh-tool-library/src/index.js');
    const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/dav/MyLibrary/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/MyLibrary/library.json</d:href>
    <d:propstat><d:prop>
      <d:getcontentlength>2048</d:getcontentlength>
      <d:getlastmodified>Sat, 16 Oct 2026 10:30:00 GMT</d:getlastmodified>
    </d:prop></d:propstat>
  </d:response>
</d:multistatus>`;
    const files = plugin.parseWebDavMultistatus(xml, '/dav/MyLibrary/');
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: '/dav/MyLibrary/library.json', isDirectory: false, sizeBytes: 2048 });
  });

  it('validateRemoteSource 校验网盘配置', async () => {
    const { validateDocument } = await import('@bookstore/mylibrary-core');
    expect(validateDocument('remote-source', { baseUrl: 'https://dav.jianguoyun.com/dav/', username: 'u', password: 'p', rootPath: '/MyLibrary' }).ok).toBe(true);
    expect(validateDocument('remote-source', { baseUrl: 'not-a-url', username: 'u', password: 'p', rootPath: '/' }).ok).toBe(false);
    expect(validateDocument('remote-source', { accessToken: 't', appName: 'ebook' }).ok).toBe(true);
  });
});
