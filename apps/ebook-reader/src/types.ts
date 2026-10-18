/**
 * 阅读器前端的共享类型。
 *
 * 这些类型与 `@bookstore/mylibrary-core` 的数据契约一致（设计文档 1.3 ~ 1.7），
 * 前端通过 URL 参数拿到 library 根目录与 book 路径，再经 dsh 的 `window.__DSH_FS__`
 * 读写数据层。
 *
 * @module ebook-reader/types
 */

/** 阅读器支持的格式（设计文档 2.4 渲染引擎）。 */
export type ReaderFormat = 'epub' | 'pdf' | 'markdown' | 'txt';

/** 一本书的阅读状态。 */
export interface BookSummary {
  id: string;
  title: string;
  author: string;
  format: ReaderFormat;
  relative_path: string;
  cover_path?: string;
  size_bytes: number;
  /** 0 ~ 1 */
  percentage: number;
  tags: string[];
  collections: string[];
  sync: {
    metadata: 'synced' | 'local_only' | 'partial' | 'missing';
    cover: 'synced' | 'local_only' | 'partial' | 'missing';
    notes: 'synced' | 'local_only' | 'partial' | 'missing';
    file: 'synced' | 'local_only' | 'partial' | 'missing';
    recordings: 'synced' | 'local_only' | 'partial' | 'missing';
  };
  /** 本地是否持有文件本体（false 时显示悬空引用卡片，设计文档 1.8.3）。 */
  heldByMe: boolean;
  /** 可能持有此文件的其它设备。 */
  holders: { client_id: string; last_seen: string }[];
}

/** 一条批注（与笔记边车一致）。 */
export interface Annotation {
  id: string;
  type: 'highlight' | 'note' | 'ink';
  anchor: unknown;
  text?: string;
  note?: string;
  color?: string;
  strokes?: { points: { x: number; y: number; pressure: number; t: number }[]; color: string; width: number }[];
  created_at: string;
  updated_at: string;
}

/** 一条录课视频。 */
export interface Recording {
  id: string;
  title: string;
  file: string;
  duration_seconds: number;
  position_at_start?: string;
  position_at_end?: string;
}

/** 前端从 dsh 注入的宿主能力。 */
export interface DshHost {
  /** 读取文件（文本）。 */
  readText(path: string): Promise<string>;
  /** 读取文件（二进制，用于 EPUB / PDF）。 */
  readBinary(path: string): Promise<ArrayBuffer>;
  /** 写回文件（文本）。 */
  writeText(path: string, content: string): Promise<void>;
  /** 写回文件（二进制，用于 PDF 注释）。 */
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  /** 调起 dsh 工具（例如 translate_text）。 */
  callTool(name: string, args: unknown): Promise<unknown>;
}

declare global {
  interface Window {
    /** dsh Web Client 注入的文件系统能力（设计文档 2.4）。 */
    __DSH_FS__?: DshHost;
  }
}
