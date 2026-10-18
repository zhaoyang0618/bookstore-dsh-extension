/**
 * 应用外壳与 hash 路由。
 *
 * @module ebook-reader/App
 */

import { useEffect } from 'react';

import { LibraryPage } from './pages/LibraryPage.js';
import { ReaderPage } from './pages/ReaderPage.js';
import { RecordPage } from './pages/RecordPage.js';
import { WikiPageView } from './pages/WikiPageView.js';
import { parseEntry } from './host.js';
import { useReaderStore } from './store.js';

/** 应用根组件。 */
export function App(): React.JSX.Element {
  const { libraryRoot, error } = useReaderStore();

  useEffect(() => {
    const sync = (): void => {
      const entry = parseEntry(window.location.search, window.location.hash);
      if (entry.libraryRoot.length > 0 && entry.libraryRoot !== libraryRoot) {
        useReaderStore.setState({ libraryRoot: entry.libraryRoot });
      }
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [libraryRoot]);

  const route = window.location.hash.replace(/^#/, '') || 'library';

  return (
    <div className="app">
      <nav className="app-nav">
        <a href="#library">图书馆</a>
        <a href="#reader">阅读器</a>
        <a href="#record">录课</a>
        <a href="#wiki">Wiki</a>
      </nav>
      {error !== undefined && <div className="app-error">{error}</div>}
      <main className="app-main">
        {route === 'library' && <LibraryPage />}
        {route === 'reader' && <ReaderPage />}
        {route === 'record' && <RecordPage />}
        {route === 'wiki' && <WikiPageView />}
      </main>
    </div>
  );
}
