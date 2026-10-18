/**
 * 图书馆状态管理（设计文档 2.5：library.json 读写 + 本地索引）。
 *
 * 前端不直接 import mylibrary-core（它是 Node 包），而是通过宿主能力读写
 * `library.json` 与笔记边车。这里只负责前端的状态与派生数据。
 *
 * @module ebook-reader/store
 */

import { create } from 'zustand';

import type { Annotation, BookSummary, Recording } from './types.js';

/** library.json 中一本书的原始形状（与数据契约一致）。 */
export interface RawBook {
  id: string;
  title: string;
  author: string;
  format: string;
  relative_path: string;
  cover_path?: string;
  size_bytes: number;
  sync_state: BookSummary['sync'];
  held_by: { client_id: string; last_seen: string }[];
  reading_position?: { position: string; percentage: number; updated_at: string; updated_by: string };
  tags?: string[];
  collections?: string[];
}

/** library.json 的原始形状。 */
export interface RawLibrary {
  schema_version: string;
  version: number;
  updated_at: string;
  updated_by: string;
  books: RawBook[];
  collections: { id: string; name: string }[];
  tags: { name: string }[];
}

/** 阅读器全局状态。 */
export interface ReaderState {
  libraryRoot: string;
  library: RawLibrary | undefined;
  /** 当前打开的书。 */
  currentBook: BookSummary | undefined;
  /** 当前书的批注列表。 */
  annotations: Annotation[];
  /** 当前书的录课视频。 */
  recordings: Recording[];
  /** 悬空引用提示（设计文档 1.8.3）。 */
  dangling: BookSummary | undefined;
  loading: boolean;
  error: string | undefined;
  setLibrary: (library: RawLibrary, root: string) => void;
  openBook: (book: BookSummary) => void;
  setAnnotations: (annotations: Annotation[]) => void;
  setRecordings: (recordings: Recording[]) => void;
  setDangling: (book: BookSummary | undefined) => void;
  setError: (message: string | undefined) => void;
  setLoading: (loading: boolean) => void;
}

/** 把 RawBook 转成界面用的 BookSummary。 */
export function toBookSummary(raw: RawBook, clientId: string): BookSummary {
  return {
    id: raw.id,
    title: raw.title,
    author: raw.author,
    format: raw.format as BookSummary['format'],
    relative_path: raw.relative_path,
    cover_path: raw.cover_path,
    size_bytes: raw.size_bytes,
    percentage: raw.reading_position?.percentage ?? 0,
    tags: raw.tags ?? [],
    collections: raw.collections ?? [],
    sync: raw.sync_state,
    heldByMe: raw.held_by.some((holder) => holder.client_id === clientId),
    holders: raw.held_by,
  };
}

/** 使用 zustand 管理阅读器状态。 */
export const useReaderStore = create<ReaderState>((set) => ({
  libraryRoot: '',
  library: undefined,
  currentBook: undefined,
  annotations: [],
  recordings: [],
  dangling: undefined,
  loading: false,
  error: undefined,
  setLibrary: (library, libraryRoot) => set({ library, libraryRoot, error: undefined }),
  openBook: (currentBook) => set({ currentBook, annotations: [], recordings: [] }),
  setAnnotations: (annotations) => set({ annotations }),
  setRecordings: (recordings) => set({ recordings }),
  setDangling: (dangling) => set({ dangling }),
  setError: (error) => set({ error }),
  setLoading: (loading) => set({ loading }),
}));

/** 筛选出「文件不可达」的书（设计文档 1.8.3 悬空引用）。 */
export function findDangling(books: BookSummary[]): BookSummary | undefined {
  return books.find((book) => book.sync.file === 'missing' || (!book.heldByMe && book.sync.file === 'local_only'));
}

/** 按收藏夹 / 标签分组，供图书馆界面分组展示。 */
export function groupBooks(books: BookSummary[]): { key: string; books: BookSummary[] }[] {
  const groups = new Map<string, BookSummary[]>();
  for (const book of books) {
    const keys = book.collections.length > 0 ? book.collections : ['未分类'];
    for (const key of keys) {
      const list = groups.get(key) ?? [];
      list.push(book);
      groups.set(key, list);
    }
  }
  return [...groups.entries()].map(([key, list]) => ({ key, books: list }));
}
