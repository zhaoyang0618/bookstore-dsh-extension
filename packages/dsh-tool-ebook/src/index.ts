/**
 * dsh 扩展版 — 电子书工具插件（设计文档 2.3）。
 *
 * 注册 `open_ebook(bookPath)` 与 `convert_and_open(bookPath)` 两个工具。
 * 工具返回 UI 指令（`{ action: 'open_url', url }`），由 dsh Web Client 打开独立前端。
 * 工具插件**不注册** `ConversationNodeDefinition`，因此不出现在 Chat 消息流中。
 *
 * 架构（设计文档 2.2）：
 *   dsh Chat 界面 → 工具卡片 → 点击 → 打开独立功能界面（ebook-reader 前端）
 *
 * @module dsh-tool-ebook
 */

import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { FsError } from '@deepseek-ai/dsh-fs';
import { inferFormat, MyLibraryError, type BookFormat } from 'mylibrary-core';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolRuntime } from '@deepseek-ai/dsh-tools';
import type { FileSystem as FsService } from '@deepseek-ai/dsh-fs';

/** apply() 收到的 agent-scoped 服务集合。 */
type PluginContext = Context & { tools: ToolRuntime; fs?: FsService };

interface PluginConfig {
  readerBaseUrl: string;
  libraryRoot: string;
}

/**
 * 构造 fs.resolve 的选项：cwd 未定义时不传该键，
 * 以满足 exactOptionalPropertyTypes 对可选属性的约束。
 */
function resolveOptions(exec: { agent?: { session: { header: { cwd?: string } } }; signal: AbortSignal }): { cwd?: string; signal: AbortSignal } {
  const cwd = exec.agent?.session.header.cwd;
  return cwd === undefined ? { signal: exec.signal } : { cwd, signal: exec.signal };
}

/** 把 fs.resolve 返回的 FsTarget 归一化为字符串路径。 */
function fsTargetToString(target: unknown): string {
  if (typeof target === 'string') return target;
  if (typeof target === 'object' && target !== null && 'path' in target && typeof (target as { path: unknown }).path === 'string') {
    return (target as { path: string }).path;
  }
  return String(target);
}

/** Stable Loader identity。 */
const name = 'dsh-tool-ebook';

/** 插件配置。 */
const Config = z.object({
  /** 阅读器前端的基地址，工具返回的 URL 基于它拼接。 */
  readerBaseUrl: z.string().default('http://127.0.0.1:5173'),
  /** MyLibrary 根目录；为空时表示由前端自行选择。 */
  libraryRoot: z.string().default(''),
});

/** 本插件用到的服务。 */
const inject = ['tools', 'fs'];

/** 一个前端路由指令。 */
export interface OpenUrlInstruction {
  action: 'open_url';
  url: string;
}

/** 需要转换的格式（阅读器不直接支持的格式）。 */
const NEEDS_CONVERSION: readonly string[] = ['mobi', 'azw3', 'djvu', 'chm'];

/**
 * 判断一个路径是否可以被阅读器直接打开。
 *
 * 渲染引擎（设计文档 2.4）：EPUB → foliate-js，PDF → PDF.js，
 * Markdown → markdown-it，TXT → 自研分页器。
 */
export function isDirectlyRenderable(path: string): boolean {
  try {
    const format = inferFormat(path);
    return format === 'epub' || format === 'pdf' || format === 'markdown' || format === 'txt';
  } catch {
    return false;
  }
}

/** 由路径推断格式（导出供测试）。 */
export function formatOf(path: string): BookFormat {
  return inferFormat(path);
}

/** 构造打开某本书的 URL。 */
export function buildReaderUrl(baseUrl: string, params: { bookPath?: string; libraryRoot?: string; page?: string }): string {
  const url = new URL(baseUrl);
  if (params.libraryRoot !== undefined && params.libraryRoot.length > 0) {
    url.searchParams.set('library', params.libraryRoot);
  }
  if (params.bookPath !== undefined && params.bookPath.length > 0) {
    url.searchParams.set('book', params.bookPath);
  }
  if (params.page !== undefined) {
    url.hash = params.page;
  }
  return url.toString();
}

/** 构造图书馆界面的 URL。 */
export function buildLibraryUrl(baseUrl: string, libraryRoot?: string): string {
  return buildReaderUrl(baseUrl, {
    ...(libraryRoot !== undefined ? { libraryRoot } : {}),
    page: 'library',
  });
}

/**
 * 注册两个电子书工具。
 *
 * @param ctx - agent-scoped services。
 * @param config - readerBaseUrl / libraryRoot。
 */
function apply(ctx: PluginContext, config: PluginConfig) {
  const readerBaseUrl = config.readerBaseUrl.replace(/\/+$/, '');

  ctx.tools.register(defineTool({
    name: 'open_ebook',
    description:
      '在电子书阅读器中打开一本书。支持 EPUB / PDF / Markdown / TXT；其它格式请先用 convert_and_open 转换。' +
      '返回一个 open_url 指令，由客户端打开独立的阅读器界面。',
    parameters: {
      bookPath: {
        type: 'string',
        required: true,
        description: '电子书文件路径（相对工作区或绝对路径）',
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
          book: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              path: { type: 'string', required: true },
              format: { type: 'string', required: true },
              directlyRenderable: { type: 'boolean', required: true },
              needsConversion: { type: 'boolean', required: true },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: [
            `打开电子书：${value.book.path}`,
            `格式：${value.book.format}`,
            value.book.needsConversion ? '该格式需要先转换，请使用 convert_and_open。' : '已在阅读器中打开。',
            `URL：${value.instruction.url}`,
          ].join('\n'),
        },
      ],
    },
    async execute(args, exec) {
      const path = args.bookPath.trim();
      if (path.length === 0) throw new Error('open_ebook 需要一个非空的 bookPath');
      const target = await ctx.fs.resolve(path, resolveOptions(exec));
      const info = await ctx.fs.stat(target, exec.signal);
      const resolved = fsTargetToString(target);
      if (info === undefined || info.type !== 'file') {
        throw new FsError(`电子书不存在或不是文件：${path}`, 'FS_NOT_FOUND');
      }
      exec.signal.throwIfAborted();
      let format: BookFormat;
      try {
        format = inferFormat(path);
      } catch (error) {
        throw new MyLibraryError('UNSUPPORTED_FORMAT', (error as Error).message);
      }
      const needsConversion = NEEDS_CONVERSION.includes(format);
      return {
        instruction: { action: 'open_url' as const, url: buildReaderUrl(readerBaseUrl, { bookPath: resolved, libraryRoot: config.libraryRoot }) },
        book: { path: resolved, format, directlyRenderable: isDirectlyRenderable(path), needsConversion },
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'convert_and_open',
    description:
      '把不支持的电子书格式（MOBI / AZW3 / DjVu / CHM）转换为阅读器可渲染的格式，然后打开。' +
      '转换通过 convert-tool 插件提供的转换能力完成；当前实现返回待转换清单与目标路径，由前端执行实际转换。',
    parameters: {
      bookPath: {
        type: 'string',
        required: true,
        description: '待转换的电子书文件路径',
      },
      targetFormat: {
        type: 'string',
        description: '目标格式，默认 epub（MOBI/AZW3）或 pdf（Djvu）',
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
          conversion: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              sourcePath: { type: 'string', required: true },
              sourceFormat: { type: 'string', required: true },
              targetFormat: { type: 'string', required: true },
              targetPath: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: [
            `转换并打开：${value.conversion.sourcePath}`,
            `${value.conversion.sourceFormat} → ${value.conversion.targetFormat}`,
            `目标文件：${value.conversion.targetPath}`,
            `URL：${value.instruction.url}`,
          ].join('\n'),
        },
      ],
    },
    async execute(args, exec) {
      const path = args.bookPath.trim();
      if (path.length === 0) throw new Error('convert_and_open 需要一个非空的 bookPath');
      const target = await ctx.fs.resolve(path, resolveOptions(exec));
      const info = await ctx.fs.stat(target, exec.signal);
      const resolved = fsTargetToString(target);
      if (info === undefined || info.type !== 'file') {
        throw new FsError(`电子书不存在或不是文件：${path}`, 'FS_NOT_FOUND');
      }
      exec.signal.throwIfAborted();
      let sourceFormat: string;
      try {
        sourceFormat = inferFormat(path);
      } catch {
        // 未知扩展名时按原扩展名处理（例如 .mobi）
        sourceFormat = path.toLowerCase().split('.').pop() ?? 'unknown';
      }
      const targetFormat = args.targetFormat?.trim() || defaultTargetFormat(sourceFormat);
      const targetPath = resolved.replace(/\.[^./]+$/, `.${targetFormat}`);
      return {
        instruction: { action: 'open_url' as const, url: buildReaderUrl(readerBaseUrl, { bookPath: targetPath, libraryRoot: config.libraryRoot }) },
        conversion: { sourcePath: resolved, sourceFormat, targetFormat, targetPath },
      };
    },
  }));
}

/** 由源格式推导默认目标格式。 */
export function defaultTargetFormat(sourceFormat: string): string {
  switch (sourceFormat.toLowerCase()) {
    case 'mobi':
    case 'azw3':
      return 'epub';
    case 'djvu':
      return 'pdf';
    default:
      return 'epub';
  }
}

export { Config, apply, inject, name };
