/**
 * 图书馆界面（设计文档 2.5）。
 *
 * 展示全部书籍、封面、阅读进度、同步状态，并处理悬空引用（设计文档 1.8.3）。
 *
 * @module ebook-reader/pages/LibraryPage
 */

import { useMemo } from 'react';

import { findDangling, groupBooks, toBookSummary, useReaderStore } from '../store.js';
import { resolveHost } from '../host.js';
import type { RawBook } from '../store.js';

/** 图书馆页。 */
export function LibraryPage(): React.JSX.Element {
  const { library, libraryRoot, openBook, setLoading, setError, dangling, setDangling } = useReaderStore();

  const books = useMemo(() => {
    if (library === undefined) return [];
    return library.books.map((raw: RawBook) => toBookSummary(raw, 'dsh-extension-client'));
  }, [library]);

  const groups = useMemo(() => groupBooks(books), [books]);

  /** 从宿主读取 library.json。 */
  const load = async (): Promise<void> => {
    if (libraryRoot.trim().length === 0) {
      setError('未指定 library 根目录');
      return;
    }
    setLoading(true);
    try {
      const host = resolveHost();
      const raw = JSON.parse(await host.readText(`${libraryRoot}/library.json`)) as {
        schema_version: string;
        version: number;
        updated_at: string;
        updated_by: string;
        books: RawBook[];
        collections: { id: string; name: string }[];
        tags: { name: string }[];
      };
      useReaderStore.getState().setLibrary(raw, libraryRoot);
      setDangling(findDangling(raw.books.map((b) => toBookSummary(b, 'dsh-extension-client'))));
    } catch (error) {
      setError(`读取 library.json 失败：${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="library">
      <header className="library-header">
        <h1>我的图书馆</h1>
        <div className="library-meta">
          {library !== undefined && (
            <span>
              v{library.version} · {books.length} 本书 · 更新于 {new Date(library.updated_at).toLocaleString()}
            </span>
          )}
          <button type="button" onClick={() => void load()}>
            刷新
          </button>
        </div>
      </header>

      {dangling !== undefined && (
        <section className="dangling">
          <h2>
            ⚠️ 《{dangling.title}》文件尚未同步
          </h2>
          <p>
            {dangling.author} · {dangling.size_bytes} 字节 · 已读 {Math.round(dangling.percentage * 100)}%
          </p>
          <p>可能持有此文件的设备：</p>
          <ul>
            {dangling.holders.map((holder: { client_id: string; last_seen: string }) => (
              <li key={holder.client_id}>
                {holder.client_id} · 最后在线 {new Date(holder.last_seen).toLocaleString()}
              </li>
            ))}
          </ul>
          <div className="dangling-actions">
            <button type="button">向这些设备请求同步</button>
            <button type="button">从网盘其他位置扫描</button>
            <button type="button">仅保留元数据</button>
            <button type="button">从图书馆移除</button>
          </div>
        </section>
      )}

      {groups.map((group) => (
        <section key={group.key} className="library-group">
          <h2>{group.key}</h2>
          <div className="book-grid">
            {group.books.map((book) => (
              <article key={book.id} className="book-card" onClick={() => openBook(book)}>
                {book.cover_path !== undefined ? (
                  <img src={`${libraryRoot}/${book.cover_path}`} alt={book.title} className="book-cover" />
                ) : (
                  <div className="book-cover book-cover-placeholder">{book.title.slice(0, 1)}</div>
                )}
                <h3>{book.title}</h3>
                <p className="book-author">{book.author}</p>
                <div className="book-progress">
                  <div className="book-progress-bar" style={{ width: `${Math.round(book.percentage * 100)}%` }} />
                </div>
                <p className="book-meta">
                  {Math.round(book.percentage * 100)}% · {book.format.toUpperCase()}
                </p>
                <div className="book-sync">
                  <SyncBadge label="元数据" state={book.sync.metadata} />
                  <SyncBadge label="封面" state={book.sync.cover} />
                  <SyncBadge label="笔记" state={book.sync.notes} />
                  <SyncBadge label="文件" state={book.sync.file} />
                </div>
                {book.tags.length > 0 && (
                  <p className="book-tags">{book.tags.map((tag: string) => `#${tag}`).join(' ')}</p>
                )}
              </article>
            ))}
          </div>
        </section>
      ))}

      {books.length === 0 && library !== undefined && <p className="library-empty">图书馆是空的。用 open_library 或导入功能添加书籍。</p>}
    </div>
  );
}

/** 同步状态徽章。 */
function SyncBadge({ label, state }: { label: string; state: string }): React.JSX.Element {
  const icon = state === 'synced' ? '✓' : state === 'local_only' ? '本' : state === 'partial' ? '◐' : '✗';
  return (
    <span className={`sync-badge sync-${state}`} title={`${label}：${state}`}>
      {icon}
      {label}
    </span>
  );
}
