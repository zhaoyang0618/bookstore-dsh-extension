/**
 * 阅读器前端的宿主桥接层。
 *
 * dsh Web Client 通过 `window.__DSH_FS__` 注入文件系统能力（设计文档 2.4）。
 * 在没有宿主环境时（例如独立打开前端做开发），回退到一个内存假实现，
 * 保证界面可以单独开发与截图。
 *
 * @module ebook-reader/host
 */

import type { BookSummary, DshHost } from './types.js';

/** 从 URL 查询参数解析前端入口状态。 */
export interface ReaderEntry {
  /** MyLibrary 根目录（绝对路径）。 */
  libraryRoot: string;
  /** 要打开的书（相对 libraryRoot 的路径）。 */
  bookPath?: string;
  /** hash 路由：library / wiki / {slug} */
  route: string;
}

/** 解析 `?library=...&book=...#library` 形式的入口参数。 */
export function parseEntry(search: string, hash: string): ReaderEntry {
  const params = new URLSearchParams(search);
  const route = hash.replace(/^#/, '') || 'library';
  return {
    libraryRoot: params.get('library') ?? '',
    bookPath: params.get('book') ?? undefined,
    route,
  };
}

/** 内存假实现：仅供无宿主环境下的界面开发。 */
export function createMockHost(books: BookSummary[]): DshHost {
  const files = new Map<string, string>();
  files.set('/mock/library.json', JSON.stringify({ schema_version: '1.0', version: 1, books: [] }));
  return {
    async readText(path: string) {
      const content = files.get(path);
      if (content === undefined) throw new Error(`mock: 文件不存在 ${path}`);
      return content;
    },
    async readBinary(path: string) {
      void path;
      void books;
      return new ArrayBuffer(0);
    },
    async writeText(path: string, content: string) {
      files.set(path, content);
    },
    async writeBinary(path: string, _data: ArrayBuffer) {
      void path;
    },
    async callTool(name: string, args: unknown) {
      void args;
      return { mock: true, tool: name };
    },
  };
}

/** 取宿主能力；没有注入时用 mock。 */
export function resolveHost(): DshHost {
  if (typeof window !== 'undefined' && window.__DSH_FS__ !== undefined) return window.__DSH_FS__;
  return createMockHost([]);
}

/** 判断一本书的格式是否可渲染。 */
export function isRenderable(format: string): boolean {
  return format === 'epub' || format === 'pdf' || format === 'markdown' || format === 'txt';
}
