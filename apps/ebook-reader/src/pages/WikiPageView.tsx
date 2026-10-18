/**
 * Wiki 界面（设计文档 2.8：浏览、编辑、图谱可视化）。
 *
 * @module ebook-reader/pages/WikiPageView
 */

import { useEffect, useMemo, useState } from 'react';

import { resolveHost } from '../host.js';

/** Wiki 页面的 frontmatter（与数据契约 1.6 一致）。 */
interface WikiFrontmatter {
  id: string;
  slug: string;
  title: string;
  tags: string[];
  source_books: string[];
  links: string[];
}

/** 一个 Wiki 页面。 */
interface WikiPage {
  frontmatter: WikiFrontmatter;
  body: string;
}

/** Wiki 页。 */
export function WikiPageView(): React.JSX.Element {
  const [pages, setPages] = useState<WikiPage[]>([]);
  const [currentSlug, setCurrentSlug] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const libraryRoot = useMemo(() => new URLSearchParams(window.location.search).get('library') ?? '', []);

  useEffect(() => {
    void (async () => {
      try {
        const host = resolveHost();
        const index = JSON.parse(await host.readText(`${libraryRoot}/wiki/index.json`)) as {
          pages: { slug: string; title: string; path: string }[];
        };
        const loaded: WikiPage[] = [];
        for (const entry of index.pages) {
          const content = await host.readText(`${libraryRoot}/wiki/pages/${entry.path}`);
          loaded.push(parsePage(content));
        }
        setPages(loaded);
        if (currentSlug === undefined && loaded.length > 0) setCurrentSlug(loaded[0]?.frontmatter.slug);
      } catch (cause) {
        setError(`读取 Wiki 失败：${(cause as Error).message}`);
      }
    })();
  }, [libraryRoot, currentSlug]);

  const current = pages.find((page) => page.frontmatter.slug === currentSlug);

  /** 反链：哪些页面链接到当前页。 */
  const backlinks = useMemo(() => {
    if (current === undefined) return [];
    return pages.filter((page) => page.frontmatter.links.includes(current.frontmatter.slug));
  }, [pages, current]);

  /** 保存编辑后的正文。 */
  const save = async (): Promise<void> => {
    if (current === undefined) return;
    const host = resolveHost();
    const path = `${libraryRoot}/wiki/pages/${current.frontmatter.slug}.md`;
    await host.writeText(path, serialize(current.frontmatter, draft));
    setPages(pages.map((page) => (page.frontmatter.slug === currentSlug ? { ...page, body: draft } : page)));
    setEditing(false);
  };

  if (error !== undefined) return <div className="wiki-error">{error}</div>;

  return (
    <div className="wiki">
      <aside className="wiki-sidebar">
        <h1>Wiki</h1>
        <ul className="wiki-list">
          {pages.map((page) => (
            <li key={page.frontmatter.slug}>
              <button
                type="button"
                className={page.frontmatter.slug === currentSlug ? 'active' : ''}
                onClick={() => {
                  setCurrentSlug(page.frontmatter.slug);
                  setEditing(false);
                }}
              >
                {page.frontmatter.title}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="wiki-main">
        {current === undefined ? (
          <p>选择或创建一个 Wiki 页面。</p>
        ) : (
          <>
            <header className="wiki-header">
              <h2>{current.frontmatter.title}</h2>
              <button type="button" onClick={() => { setDraft(current.body); setEditing(!editing); }}>
                {editing ? '取消' : '编辑'}
              </button>
              {editing && (
                <button type="button" onClick={() => void save()}>
                  保存（⌘S）
                </button>
              )}
            </header>

            {current.frontmatter.tags.length > 0 && (
              <p className="wiki-tags">{current.frontmatter.tags.map((t) => `#${t}`).join(' ')}</p>
            )}

            {editing ? (
              <textarea className="wiki-editor" value={draft} onChange={(event) => setDraft(event.target.value)} rows={24} />
            ) : (
              <article className="wiki-body">
                {current.body.split('\n').map((line, index) =>
                  line.startsWith('#') ? (
                    <h3 key={index}>{line.replace(/^#+\s*/, '')}</h3>
                  ) : (
                    <p key={index}>{line}</p>
                  ),
                )}
              </article>
            )}

            <section className="wiki-links">
              <h4>出链</h4>
              <ul>
                {current.frontmatter.links.map((link) => (
                  <li key={link}>
                    <button type="button" onClick={() => setCurrentSlug(link)}>
                      {link}
                    </button>
                  </li>
                ))}
              </ul>
              <h4>反链（{backlinks.length}）</h4>
              <ul>
                {backlinks.map((page) => (
                  <li key={page.frontmatter.slug}>
                    <button type="button" onClick={() => setCurrentSlug(page.frontmatter.slug)}>
                      {page.frontmatter.title}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

/** 解析一个 Wiki 页面文件。 */
function parsePage(content: string): WikiPage {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(content);
  if (match === null) throw new Error('缺少 frontmatter');
  const [, yaml, body] = match;
  const frontmatter = { id: '', slug: '', title: '', tags: [], source_books: [], links: [] } as WikiFrontmatter;
  for (const line of (yaml ?? '').split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv === null) continue;
    const [, key, value] = kv;
    if (key === 'tags' || key === 'source_books' || key === 'links') {
      frontmatter[key as 'tags'] = (value ?? '')
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    } else {
      (frontmatter as unknown as Record<string, string>)[key as string] = value ?? '';
    }
  }
  return { frontmatter, body: body ?? '' };
}

/** 序列化回文件。 */
function serialize(frontmatter: WikiFrontmatter, body: string): string {
  return `---\nid: ${frontmatter.id}\nslug: ${frontmatter.slug}\ntitle: ${frontmatter.title}\ntags: [${frontmatter.tags.join(', ')}]\nsource_books: [${frontmatter.source_books.join(', ')}]\nlinks: [${frontmatter.links.join(', ')}]\n---\n\n${body.trimEnd()}\n`;
}
