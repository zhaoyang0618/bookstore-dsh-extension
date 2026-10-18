/**
 * 网盘抽象层（设计文档 2.5）。
 *
 * `RemoteProvider` 接口是两个软件共有的契约（设计文档 4.3），
 * dsh 版用 TypeScript interface，Flutter 版用 Dart abstract class。
 *
 * 本模块提供：
 * - `RemoteProvider` 接口定义
 * - `WebDavProvider`：坚果云 / Nextcloud / 群晖 NAS（首选）
 * - `BaiduProvider`：百度网盘（注意 `/apps/{产品名}/` 目录限制与 refresh_token 一次性）
 * - 拉取外部图书的两条路径（下载→上传 / 网盘内复制）
 *
 * @module dsh-tool-library/remote
 */

import { createHash } from 'node:crypto';
import { basename } from 'node:path';

/** 网盘上的一个文件 / 目录条目。 */
export interface RemoteFile {
  /** 网盘上的完整路径。 */
  path: string;
  /** 是否为目录。 */
  isDirectory: boolean;
  sizeBytes: number;
  /** 最后修改时间（ISO 8601）。 */
  modifiedAt: string;
  /** 文件哈希（若有）。 */
  etag?: string;
}

/**
 * 网盘抽象接口（设计文档 2.5）。
 *
 * 所有网盘 API 变更都隔离在各自的适配器里（设计文档第七部分风险应对）。
 */
export interface RemoteProvider {
  readonly id: 'webdav' | 'baidu';
  authenticate(): Promise<void>;
  listFiles(path: string): Promise<RemoteFile[]>;
  downloadFile(remotePath: string, localPath: string): Promise<void>;
  uploadFile(localPath: string, remotePath: string): Promise<void>;
  copyFile(src: string, dst: string): Promise<void>;
  moveFile(src: string, dst: string): Promise<void>;
  isConnected(): boolean;
}

/** WebDAV 配置。 */
export interface WebDavConfig {
  /** 例如 `https://dav.jianguoyun.com/dav/` */
  baseUrl: string;
  username: string;
  /** 应用密码（非登录密码）。 */
  password: string;
  /** MyLibrary 在网盘上的根路径。 */
  rootPath: string;
}

/**
 * WebDAV 适配器（设计文档 2.5：支持坚果云、Nextcloud、群晖 NAS）。
 *
 * 通过 dsh 工具插件的 IPC 通道在 Node.js 侧发起请求，避免浏览器 CORS 限制。
 * 本实现只依赖 `fetch`，真实环境中由 Node 侧注入带认证的 fetcher。
 */
export class WebDavProvider implements RemoteProvider {
  readonly id = 'webdav' as const;
  private connected = false;

  constructor(
    private readonly config: WebDavConfig,
    /** 可注入的 fetcher，便于测试与自定义重试策略。 */
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  isConnected(): boolean {
    return this.connected;
  }

  async authenticate(): Promise<void> {
    const response = await this.request('PROPFIND', this.config.rootPath, { Depth: '0' });
    if (!response.ok && response.status !== 207) {
      throw new Error(`WebDAV 认证失败：HTTP ${response.status}`);
    }
    this.connected = true;
  }

  async listFiles(path: string): Promise<RemoteFile[]> {
    const response = await this.request('PROPFIND', path, { Depth: '1' });
    if (response.status !== 207) throw new Error(`WebDAV 列表失败：HTTP ${response.status}`);
    const body = await response.text();
    return parseWebDavMultistatus(body, path);
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    const response = await this.request('GET', remotePath);
    if (!response.ok) throw new Error(`WebDAV 下载失败：HTTP ${response.status}`);
    await writeLocal(localPath, Buffer.from(await response.arrayBuffer()));
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    const response = await this.request('PUT', remotePath, { body: await readLocal(localPath) });
    if (!response.ok && response.status !== 201 && response.status !== 204) {
      throw new Error(`WebDAV 上传失败：HTTP ${response.status}`);
    }
  }

  async copyFile(src: string, dst: string): Promise<void> {
    const response = await this.request('COPY', src, { headers: { Destination: this.urlFor(dst), Overwrite: 'T' } });
    if (!response.ok && response.status !== 201 && response.status !== 204) {
      throw new Error(`WebDAV 复制失败：HTTP ${response.status}`);
    }
  }

  async moveFile(src: string, dst: string): Promise<void> {
    const response = await this.request('MOVE', src, { headers: { Destination: this.urlFor(dst), Overwrite: 'T' } });
    if (!response.ok && response.status !== 201 && response.status !== 204) {
      throw new Error(`WebDAV 移动失败：HTTP ${response.status}`);
    }
  }

  private urlFor(path: string): string {
    return `${this.config.baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
  }

  private async request(method: string, path: string, init: RequestInit & { Depth?: string } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has('Authorization')) headers.set('Authorization', basicAuth(this.config.username, this.config.password));
    if (init.Depth !== undefined) headers.set('Depth', init.Depth);
    if (method === 'PROPFIND' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/xml');
    return this.fetcher(this.urlFor(path), { ...init, method, headers });
  }
}

/** 构造 HTTP Basic 认证头。 */
export function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

/** 解析 WebDAV `207 Multi-Status` 响应体中的条目。 */
export function parseWebDavMultistatus(xml: string, basePath: string): RemoteFile[] {
  const files: RemoteFile[] = [];
  const responseRe = /<d:response>([\s\S]*?)<\/d:response>/g;
  for (const match of xml.matchAll(responseRe)) {
    const block = match[1] ?? '';
    const href = /<d:href>([\s\S]*?)<\/d:href>/.exec(block)?.[1];
    if (href === undefined) continue;
    const path = decodeURIComponent(href);
    if (path === basePath || `${path}/` === basePath) continue;
    const isCollection = /<d:collection/.test(block);
    const sizeText = /<d:getcontentlength>(\d+)<\/d:getcontentlength>/.exec(block)?.[1];
    const modified = /<d:getlastmodified>([\s\S]*?)<\/d:getlastmodified>/.exec(block)?.[1];
    files.push({
      path,
      isDirectory: isCollection,
      sizeBytes: sizeText !== undefined ? Number(sizeText) : 0,
      modifiedAt: modified !== undefined ? new Date(modified).toISOString() : new Date(0).toISOString(),
    });
  }
  return files;
}

// ---------- 百度网盘 ----------

/** 百度网盘配置。 */
export interface BaiduConfig {
  /** OAuth access token。 */
  accessToken: string;
  /** 百度网盘限制应用只能访问 `/apps/{产品名}/` 目录。 */
  appName: string;
}

/**
 * 百度网盘适配器（设计文档 2.5）。
 *
 * 注意事项：
 * - `/apps/{产品名}/` 目录限制
 * - OAuth `refresh_token` **只能使用一次**，刷新后旧 token 立即失效
 * - 推荐先用 **alist** 把百度网盘挂载为 WebDAV，复用 WebDAV 适配器
 */
export class BaiduProvider implements RemoteProvider {
  readonly id = 'baidu' as const;
  private connected = false;

  constructor(
    private readonly config: BaiduConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  /** 网盘上的应用根目录。 */
  private get appRoot(): string {
    return `/apps/${this.config.appName}`;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async authenticate(): Promise<void> {
    const response = await this.call('/rest/2.0/xpan/file?method=list&dir=' + encodeURIComponent(this.appRoot), { limit: 1 });
    this.connected = response.ok;
    if (!response.ok) throw new Error(`百度网盘认证失败：HTTP ${response.status}`);
  }

  async listFiles(path: string): Promise<RemoteFile[]> {
    const url = `/rest/2.0/xpan/file?method=list&dir=${encodeURIComponent(path)}&limit=1000`;
    const response = await this.call(url);
    if (!response.ok) throw new Error(`百度网盘列表失败：HTTP ${response.status}`);
    const body = (await response.json()) as { list?: { path: string; isdir: number; size: number; server_mtime: number }[] };
    return (body.list ?? []).map((entry) => ({
      path: entry.path,
      isDirectory: entry.isdir === 1,
      sizeBytes: entry.size,
      modifiedAt: new Date(entry.server_mtime * 1000).toISOString(),
    }));
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    // 百度网盘需要先获取 dlink 再下载
    const metaUrl = `/rest/2.0/xpan/multimedia?method=filemetas&access_token=&fsids=&dlink=1&path=${encodeURIComponent(remotePath)}`;
    const meta = await this.call(metaUrl);
    if (!meta.ok) throw new Error(`百度网盘获取下载链接失败：HTTP ${meta.status}`);
    const body = (await meta.json()) as { list?: { dlink?: string }[] };
    const dlink = body.list?.[0]?.dlink;
    if (dlink === undefined) throw new Error(`百度网盘未返回下载链接：${remotePath}`);
    const file = await this.fetcher(`${dlink}&access_token=${encodeURIComponent(this.config.accessToken)}`);
    if (!file.ok) throw new Error(`百度网盘下载失败：HTTP ${file.status}`);
    await writeLocal(localPath, Buffer.from(await file.arrayBuffer()));
  }

  /**
   * 上传文件（设计文档 1.8.6 分片流程）。
   *
   * 百度网盘的上传是三步协议，与 WebDAV 的一次 PUT 完全不同：
   * 1. `precreate` —— 提交文件元信息与分片 md5 列表，拿到 `uploadid`
   * 2. 逐片 `superfile2` —— 上传每个分片
   * 3. `create` —— 合并分片，生成最终文件
   *
   * 分片大小限制：普通用户 4 MiB，会员 16 MiB，这里用 4 MiB 保守值。
   */
  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    const content = await readLocal(localPath);
    const chunkSize = 4 * 1024 * 1024;
    const totalParts = Math.max(1, Math.ceil(content.length / chunkSize));
    const blockList = Array.from({ length: totalParts }, (_, index) => {
      const slice = content.subarray(index * chunkSize, Math.min((index + 1) * chunkSize, content.length));
      return createHash('md5').update(slice).digest('hex');
    });
    const accessToken = encodeURIComponent(this.config.accessToken);

    // 1. precreate：拿 uploadid
    const preResponse = await this.fetcher(
      `https://pan.baidu.com/rest/2.0/xpan/file?method=precreate&access_token=${accessToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          path: remotePath,
          size: String(content.length),
          isdir: '0',
          autoinit: '1',
          rtype: '3',
          block_list: JSON.stringify(blockList),
        }),
      },
    );
    if (!preResponse.ok) throw new Error(`百度网盘 precreate 失败：HTTP ${preResponse.status}`);
    const preResult = (await preResponse.json()) as { uploadid?: string; return_type?: number };
    const uploadId = preResult.uploadid;
    if (uploadId === undefined) throw new Error(`百度网盘 precreate 未返回 uploadid：${JSON.stringify(preResult)}`);

    // 2. 逐片上传
    for (let index = 0; index < totalParts; index += 1) {
      const slice = content.subarray(index * chunkSize, Math.min((index + 1) * chunkSize, content.length));
      const form = new FormData();
      form.append('partseq', String(index));
      form.append('file', new Blob([slice]), basename(remotePath));
      const partResponse = await this.fetcher(
        `https://d.pcs.baidu.com/rest/2.0/pcs/superfile2?method=upload&access_token=${accessToken}&type=tmpfile&path=${encodeURIComponent(remotePath)}&uploadid=${encodeURIComponent(uploadId)}`,
        { method: 'POST', body: form },
      );
      if (!partResponse.ok) throw new Error(`百度网盘分片 ${index} 上传失败：HTTP ${partResponse.status}`);
    }

    // 3. create：合并
    const createResponse = await this.fetcher(
      `https://pan.baidu.com/rest/2.0/xpan/file?method=create&access_token=${accessToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          path: remotePath,
          size: String(content.length),
          isdir: '0',
          rtype: '3',
          uploadid: uploadId,
          block_list: JSON.stringify(blockList),
        }),
      },
    );
    if (!createResponse.ok) throw new Error(`百度网盘 create 失败：HTTP ${createResponse.status}`);
    const createResult = (await createResponse.json()) as { return_type?: number };
    if (createResult.return_type === 1) throw new Error('百度网盘 create 合并失败');
  }

  async copyFile(src: string, dst: string): Promise<void> {
    const url = `/rest/2.0/xpan/file?method=filemanager&opera=copy&access_token=${encodeURIComponent(this.config.accessToken)}`;
    const response = await this.fetcher(`https://pan.baidu.com${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `async=1&filelist=${encodeURIComponent(JSON.stringify([{ path: src, dest: dst, newtype: 1 }]))}`,
    });
    if (!response.ok) throw new Error(`百度网盘复制失败：HTTP ${response.status}`);
  }

  async moveFile(src: string, dst: string): Promise<void> {
    const url = `/rest/2.0/xpan/file?method=filemanager&opera=move&access_token=${encodeURIComponent(this.config.accessToken)}`;
    const response = await this.fetcher(`https://pan.baidu.com${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `async=1&filelist=${encodeURIComponent(JSON.stringify([{ path: src, dest: dst }]))}`,
    });
    if (!response.ok) throw new Error(`百度网盘移动失败：HTTP ${response.status}`);
  }

  private async call(path: string, query: Record<string, string | number> = {}): Promise<Response> {
    const params = new URLSearchParams({ access_token: this.config.accessToken, ...Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])) });
    const separator = path.includes('?') ? '&' : '?';
    return this.fetcher(`https://pan.baidu.com${path}${separator}${params.toString()}`);
  }
}

// ---------- 从网盘拉取外部图书（2.5） ----------

/** 拉取路径。 */
export type PullStrategy = 'download-then-upload' | 'remote-copy';

/**
 * 选择拉取路径（设计文档 2.5）。
 *
 * - **路径 A（下载→上传）**：源和目标不在同一网盘账号，或百度网盘普通目录
 * - **路径 B（网盘内复制/移动）**：WebDAV，效率更高
 */
export function choosePullStrategy(options: {
  sameProvider: boolean;
  providerId: 'webdav' | 'baidu';
  sameAccount: boolean;
}): PullStrategy {
  if (options.sameProvider && options.providerId === 'webdav' && options.sameAccount) return 'remote-copy';
  return 'download-then-upload';
}

// ---------- 本地 IO（Node 侧） ----------

async function readLocal(path: string): Promise<Buffer> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path);
}

async function writeLocal(path: string, data: Buffer): Promise<void> {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}
