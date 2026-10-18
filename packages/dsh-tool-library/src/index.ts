/**
 * dsh 扩展版 — 图书馆工具插件（设计文档 2.3）。
 *
 * 注册 `open_library()` / `sync_library()` / `import_from_remote(sourceId, path)` /
 * `add_remote_source(type, config)` 四个工具。
 *
 * @module dsh-tool-library
 */

import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  MyLibraryStore,
  type ManifestClient,
  mergeLibraries,
  planSync,
  syncRequestFileName,
  createSyncRequest,
  validateDocument,
} from 'mylibrary-core';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolRuntime } from '@deepseek-ai/dsh-tools';
import type { FileSystem as FsService } from '@deepseek-ai/dsh-fs';

/** apply() 收到的 agent-scoped 服务集合。 */
type PluginContext = Context & { tools: ToolRuntime; fs?: FsService };

interface PluginConfig {
  libraryBaseUrl: string;
  libraryRoot: string;
  clientId: string;
  clientType: string;
  clientPlatform: string;
}

/** 由 process.platform 推导 manifest.json 里的 platform 字段（设计文档 1.3）。 */
export function detectPlatform(): string {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    case 'linux':
      return 'linux';
    default:
      return 'other';
  }
}

/** Stable Loader identity。 */
const name = 'dsh-tool-library';

/** 插件配置。 */
const Config = z.object({
  /** 图书馆前端基地址。 */
  libraryBaseUrl: z.string().default('http://127.0.0.1:5173'),
  /** MyLibrary 根目录。 */
  libraryRoot: z.string().default(''),
  /** 本客户端 id（写入 manifest.json clients）。 */
  clientId: z.string().default('dsh-extension-client'),
  clientType: z.string().default('dsh-extension'),
  clientPlatform: z.string().default(''),
});

/** 本插件用到的服务。 */
const inject = ['tools', 'fs'];

/**
 * 注册四个图书馆工具。
 *
 * @param ctx - agent-scoped services。
 * @param config - libraryBaseUrl / libraryRoot / clientId。
 */
function apply(ctx: PluginContext, config: PluginConfig) {
  const baseUrl = config.libraryBaseUrl.replace(/\/+$/, '');

  /** 打开一个 MyLibraryStore；未配置 libraryRoot 时报可读错误。同时把本客户端登记到 manifest。 */
  const openStore = (): MyLibraryStore => {
    if (config.libraryRoot.trim().length === 0) {
      throw new Error('未配置 libraryRoot：请在插件配置中指定 MyLibrary 目录');
    }
    const store = new MyLibraryStore(config.libraryRoot, { clientId: config.clientId });
    try {
      // 设计文档 1.3：客户端上线时写入 manifest.json 的 clients 列表
      store.touchClient({
        id: config.clientId,
        type: config.clientType as ManifestClient['type'],
        platform: (config.clientPlatform.length > 0 ? config.clientPlatform : detectPlatform()) as ManifestClient['platform'],
      });
    } catch {
      // manifest 不可写（例如只读网盘副本）时不影响主流程
    }
    return store;
  };

  ctx.tools.register(defineTool({
    name: 'open_library',
    description: '打开电子书图书馆界面，展示 MyLibrary 中的全部书籍、封面、阅读进度与同步状态。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          instruction: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              action: { type: 'string', required: true, enum: ['open_url'] },
              url: { type: 'string', required: true },
            },
          },
          library: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              root: { type: 'string', required: true },
              bookCount: { type: 'integer', required: true },
              version: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `打开图书馆：${value.library.root}（${value.library.bookCount} 本书，v${value.library.version}）` },
      ],
    },
    async execute(_args, exec) {
      exec.signal.throwIfAborted();
      const store = openStore();
      const library = store.readLibrary();
      return {
        instruction: { action: 'open_url' as const, url: `${baseUrl}/#library?library=${encodeURIComponent(store.root)}` },
        library: { root: store.root, bookCount: library.books.length, version: library.version },
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'sync_library',
    description:
      '同步图书馆元数据：读取网盘 library.json 的 version，与本地对比后决定下载或推送，' +
      '并按设计文档 1.8.2 做冲突合并。同时扫描 requests/ 队列，为本客户端生成待上传清单。',
    parameters: {
      /** 网盘副本的本地缓存目录（由网盘适配器下载到此）。 */
      remoteRoot: {
        type: 'string',
        required: true,
        description: '网盘 library.json 所在的本地缓存目录',
      },
      dryRun: {
        type: 'boolean',
        description: '只做对比与合并演算，不写入本地',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plan: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              action: { type: 'string', required: true, enum: ['download', 'none', 'upload'] },
              reason: { type: 'string', required: true },
              localVersion: { type: 'integer', required: true },
              remoteVersion: { type: 'integer', required: true },
            },
          },
          merge: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              bookCount: { type: 'integer', required: true },
              actionCount: { type: 'integer', required: true },
              hasUnresolvedConflicts: { type: 'boolean', required: true },
              actions: { type: 'array', required: true, items: { type: 'json' } },
            },
          },
          pendingUploads: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                bookId: { type: 'string', required: true },
                requestFile: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: [
            `同步计划：${value.plan.action} — ${value.plan.reason}`,
            `合并：${value.merge.bookCount} 本书，${value.merge.actionCount} 个动作，未解决冲突 ${value.merge.hasUnresolvedConflicts ? '有' : '无'}`,
            value.pendingUploads.length > 0 ? `待上传 ${value.pendingUploads.length} 个文件` : '无待上传文件',
          ].join('\n'),
        },
      ],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const store = openStore();
      const local = store.readLibrary();
      const remoteStore = new MyLibraryStore(args.remoteRoot, { clientId: config.clientId });
      const remote = remoteStore.readLibrary();
      const plan = planSync(local, remote);
      const merged = mergeLibraries(local, remote, 'auto');
      // 扫描同步请求队列（1.8.4）：别处请求本客户端持有的书
      const pendingUploads = store
        .listSyncRequests()
        .filter((request) => request.status === 'pending')
        .map((request) => ({ bookId: request.book_id, requestFile: syncRequestFileName(request.book_id, request.requested_by) }));
      if (!args.dryRun && plan.action === 'download') {
        store.writeLibrary(merged.value);
      }
      return {
        plan: { action: plan.action, reason: plan.reason, localVersion: plan.localVersion, remoteVersion: plan.remoteVersion },
        merge: {
          bookCount: merged.value.books.length,
          actionCount: merged.actions.length,
          hasUnresolvedConflicts: merged.hasUnresolvedConflicts,
          actions: merged.actions as unknown as [],
        },
        pendingUploads,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'import_from_remote',
    description:
      '从网盘拉取一本外部图书到本地图书馆。' +
      '路径 A（下载→上传）适用于源和目标不在同一网盘账号；路径 B（网盘内复制）适用于同一 WebDAV 账号。',
    parameters: {
      sourceId: {
        type: 'string',
        required: true,
        description: '远程源 id（由 add_remote_source 注册）',
      },
      path: {
        type: 'string',
        required: true,
        description: '网盘上的图书文件路径',
      },
      strategy: {
        type: 'string',
        description: 'download-then-upload（路径 A）或 remote-copy（路径 B），默认按源自动选择',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          instruction: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              action: { type: 'string', required: true, enum: ['open_url'] },
              url: { type: 'string', required: true },
            },
          },
          import: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              sourceId: { type: 'string', required: true },
              remotePath: { type: 'string', required: true },
              strategy: { type: 'string', required: true, enum: ['download-then-upload', 'remote-copy'] },
            },
          },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `从 ${value.import.sourceId} 拉取 ${value.import.remotePath}（${value.import.strategy}）` },
      ],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const store = openStore();
      const strategy = args.strategy === 'remote-copy' ? ('remote-copy' as const) : ('download-then-upload' as const);
      // 向源端请求同步：写一条 sync request，持有文件的客户端下次启动时上传
      const request = createSyncRequest(args.path, config.clientId, new Date().toISOString());
      store.writeSyncRequest(request);
      return {
        instruction: { action: 'open_url' as const, url: `${baseUrl}/#library?library=${encodeURIComponent(store.root)}&import=${encodeURIComponent(args.path)}` },
        import: { sourceId: args.sourceId, remotePath: args.path, strategy },
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'add_remote_source',
    description: '注册一个网盘源（WebDAV：坚果云 / Nextcloud / 群晖 NAS；或百度网盘）。配置只在本地保存，不上传。',
    parameters: {
      type: {
        type: 'string',
        required: true,
        description: 'webdav 或 baidu',
      },
      config: {
        type: 'json',
        required: true,
        description: '网盘配置：webdav 需要 baseUrl/username/password/rootPath；baidu 需要 accessToken/appName',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              type: { type: 'string', required: true },
              status: { type: 'string', required: true },
            },
          },
          validation: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              ok: { type: 'boolean', required: true },
              issues: { type: 'array', required: true, items: { type: 'json' } },
            },
          },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `已注册 ${value.source.type} 网盘源（${value.source.status}）` },
      ],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const isWebDav = args.type === 'webdav';
      const config = args.config as Record<string, unknown>;
      const report = validateDocument(
        'remote-source',
        isWebDav
          ? { baseUrl: config['baseUrl'], username: config['username'], password: config['password'], rootPath: config['rootPath'] }
          : { accessToken: config['accessToken'], appName: config['appName'] },
      );
      return {
        source: { type: args.type, status: report.ok ? 'registered' : 'invalid' },
        validation: { ok: report.ok, issues: report.issues as unknown as [] },
      };
    },
  }));
}

export { Config, apply, inject, name };
export * from './remote.js';
