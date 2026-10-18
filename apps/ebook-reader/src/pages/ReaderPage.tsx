/**
 * 阅读器界面（设计文档 2.4 / 2.7）。
 *
 * @module ebook-reader/pages/ReaderPage
 */

import { useEffect, useRef, useState } from 'react';

import { createEngine, type BookEngine } from '../engines/index.js';
import { useReaderStore } from '../store.js';
import { resolveHost } from '../host.js';
import type { Annotation } from '../types.js';

/** 阅读器页。 */
export function ReaderPage(): React.JSX.Element {
  const { currentBook, setAnnotations, setError } = useReaderStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<BookEngine | undefined>(undefined);
  const [progress, setProgress] = useState(0);
  const [selection, setSelection] = useState<string>('');
  const [translation, setTranslation] = useState<string>('');
  const [translating, setTranslating] = useState(false);

  useEffect(() => {
    if (currentBook === undefined || containerRef.current === null) return;
    let disposed = false;
    const host = resolveHost();
    const engine = createEngine(currentBook.format);
    engineRef.current = engine;

    void (async () => {
      try {
        const libraryRoot = useReaderStore.getState().libraryRoot;
        await engine.open(host, `${libraryRoot}/${currentBook.relative_path}`);
        if (disposed) return;
        await engine.render(containerRef.current!);
        const annotations = await engine.loadAnnotations();
        if (!disposed) setAnnotations(annotations);
      } catch (error) {
        if (!disposed) setError(`打开失败：${(error as Error).message}`);
      }
    })();

    return () => {
      disposed = true;
      engine.dispose();
      engineRef.current = undefined;
    };
  }, [currentBook, setAnnotations, setError]);

  /** 划词翻译（设计文档 2.7：气泡中流式显示）。 */
  const handleTranslate = async (): Promise<void> => {
    if (selection.trim().length === 0) return;
    setTranslating(true);
    setTranslation('');
    try {
      const host = resolveHost();
      const result = (await host.callTool('translate_text', { text: selection, targetLang: 'zh' })) as {
        translation?: { text?: string };
      };
      setTranslation(result.translation?.text ?? '');
    } catch (error) {
      setTranslation(`翻译失败：${(error as Error).message}`);
    } finally {
      setTranslating(false);
    }
  };

  /** 保存高亮批注到笔记边车。 */
  const handleHighlight = async (color: string): Promise<void> => {
    const engine = engineRef.current;
    if (engine === undefined || selection.trim().length === 0) return;
    const annotation: Annotation = {
      id: `anno-${Date.now().toString(36)}`,
      type: 'highlight',
      anchor: { type: 'text', value: selection.slice(0, 200) },
      text: selection,
      color,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await engine.saveAnnotations([annotation]);
    setAnnotations((await engine.loadAnnotations()) ?? []);
  };

  if (currentBook === undefined) {
    return <div className="reader-empty">从图书馆选择一本书开始阅读</div>;
  }

  return (
    <div className="reader">
      <header className="reader-toolbar">
        <button type="button" onClick={() => void engineRef.current?.prev()}>
          上一页
        </button>
        <span className="reader-progress">{Math.round(progress * 100)}%</span>
        <button
          type="button"
          onClick={() => {
            void engineRef.current?.next();
            setProgress(engineRef.current?.progress() ?? 0);
          }}
        >
          下一页
        </button>
        <span className="reader-title">
          {currentBook.title} · {currentBook.author}
        </span>
      </header>

      <div
        ref={containerRef}
        className="reader-viewport"
        onMouseUp={() => setSelection(window.getSelection()?.toString() ?? '')}
      />

      {selection.length > 0 && (
        <div className="reader-selection">
          <span className="reader-selection-text">{selection.slice(0, 80)}…</span>
          <div className="reader-selection-actions">
            {['yellow', 'green', 'blue', 'pink'].map((color) => (
              <button key={color} type="button" className={`hl hl-${color}`} onClick={() => void handleHighlight(color)}>
                {color}
              </button>
            ))}
            <button type="button" onClick={() => void handleTranslate()} disabled={translating}>
              {translating ? '翻译中…' : '翻译'}
            </button>
          </div>
          {translation.length > 0 && <div className="reader-translation">{translation}</div>}
        </div>
      )}
    </div>
  );
}
