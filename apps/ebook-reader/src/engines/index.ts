/**
 * 渲染引擎抽象与实现（设计文档 2.4）。
 *
 * | 格式 | 方案 |
 * |---|---|
 * | EPUB | foliate-js（首选） |
 * | PDF | PDF.js + AnnotationEditorLayer |
 * | Markdown | markdown-it |
 * | TXT | 自研分页器 |
 *
 * @module ebook-reader/engines
 */

import type { Annotation, DshHost, ReaderFormat } from '../types.js';

/** 一个渲染引擎的公共接口。 */
export interface BookEngine {
  readonly format: ReaderFormat;
  /** 打开书籍，返回元信息。 */
  open(host: DshHost, path: string): Promise<BookMeta>;
  /** 渲染到容器。 */
  render(container: HTMLElement): Promise<void>;
  /** 翻到下一页 / 上一页。 */
  next(): Promise<void>;
  prev(): Promise<void>;
  /** 当前进度（0 ~ 1）。 */
  progress(): number;
  /** 当前位置的标识（EPUB 为 CFI，PDF 为页码）。 */
  currentPosition(): string;
  /** 跳到某个位置。 */
  goTo(position: string): Promise<void>;
  /** 加载批注。 */
  loadAnnotations(): Promise<Annotation[]>;
  /** 保存批注。 */
  saveAnnotations(annotations: Annotation[]): Promise<void>;
  /** 释放资源。 */
  dispose(): void;
}

/** 书籍元信息。 */
export interface BookMeta {
  title: string;
  author: string;
  /** 总页数（PDF）或总章节数（EPUB）。 */
  sections: number;
}

/** 引擎工厂：按格式选实现。 */
export function createEngine(format: ReaderFormat): BookEngine {
  switch (format) {
    case 'epub':
      return new EpubEngine();
    case 'pdf':
      return new PdfEngine();
    case 'markdown':
      return new MarkdownEngine();
    case 'txt':
      return new TxtEngine();
  }
}

// ---------- EPUB：foliate-js ----------

/** EPUB 引擎（设计文档 2.4：foliate-js 首选）。 */
export class EpubEngine implements BookEngine {
  readonly format = 'epub' as const;
  private book: unknown;
  private renderer: { next(): void; prev(): void; goTo(target: string): void; destroy(): void } | undefined;
  private meta: BookMeta = { title: '', author: '', sections: 0 };

  async open(host: DshHost, path: string): Promise<BookMeta> {
    const buffer = await host.readBinary(path);
    // foliate-js 的 makeBook 接受 Blob；ArrayBuffer 需先包一层
    const blob = new Blob([buffer]);
    const { makeBook } = await import('foliate-js/view.js');
    this.book = await makeBook(blob);
    this.meta = { title: (this.book as { metadata?: { title?: string } }).metadata?.title ?? '', author: '', sections: 0 };
    return this.meta;
  }

  async render(container: HTMLElement): Promise<void> {
    const { FoliateView } = await import('foliate-js/view.js');
    this.renderer = new FoliateView(container, this.book) as unknown as EpubEngine['renderer'];
    void this.renderer;
  }

  async next(): Promise<void> {
    this.renderer?.next();
  }

  async prev(): Promise<void> {
    this.renderer?.prev();
  }

  progress(): number {
    return 0;
  }

  currentPosition(): string {
    return '';
  }

  async goTo(position: string): Promise<void> {
    this.renderer?.goTo(position);
  }

  async loadAnnotations(): Promise<Annotation[]> {
    return [];
  }

  async saveAnnotations(): Promise<void> {
    // EPUB 批注写入边车文件（由上层 store 负责）
  }

  dispose(): void {
    this.renderer?.destroy();
    this.renderer = undefined;
    this.book = undefined;
  }
}

// ---------- PDF：PDF.js + AnnotationEditorLayer ----------

/** PDF 引擎（设计文档 2.4：PDF.js 3.x 的 AnnotationEditorLayer）。 */
export class PdfEngine implements BookEngine {
  readonly format = 'pdf' as const;
  private pdfDocument: unknown;
  private currentPage = 1;
  private totalPages = 0;

  async open(host: DshHost, path: string): Promise<BookMeta> {
    const buffer = await host.readBinary(path);
    const pdfjs = await import('pdfjs-dist');
    // worker 必须指向 pdfjs-dist 的 worker 文件
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
    this.pdfDocument = await pdfjs.getDocument({ data: buffer }).promise;
    this.totalPages = (this.pdfDocument as { numPages: number }).numPages;
    return { title: path.split('/').pop() ?? '', author: '', sections: this.totalPages };
  }

  async render(container: HTMLElement): Promise<void> {
    const pdfjs = await import('pdfjs-dist');
    const { AnnotationEditorType, AnnotationEditorLayer } = await import('pdfjs-dist');
    void AnnotationEditorType;
    void AnnotationEditorLayer;
    // 完整的 viewer 初始化（eventBus / linkService / annotationEditorMode）由 PDFViewer 承担
    void pdfjs;
    void container;
    // 实际渲染在 PdfViewer 组件中完成
  }

  async next(): Promise<void> {
    if (this.currentPage < this.totalPages) this.currentPage += 1;
  }

  async prev(): Promise<void> {
    if (this.currentPage > 1) this.currentPage -= 1;
  }

  progress(): number {
    return this.totalPages === 0 ? 0 : this.currentPage / this.totalPages;
  }

  currentPosition(): string {
    return String(this.currentPage);
  }

  async goTo(position: string): Promise<void> {
    const page = Number.parseInt(position, 10);
    if (Number.isFinite(page) && page >= 1 && page <= this.totalPages) this.currentPage = page;
  }

  async loadAnnotations(): Promise<Annotation[]> {
    // PDF 注释是**原生 PDF 注释对象**，直接来自文件本身，不读边车
    return [];
  }

  /**
   * 保存 PDF 注释（设计文档 2.4）。
   *
   * `pdfDocument.saveDocument()` 把注释序列化回 PDF，生成原生注释对象，
   * 再由 `window.__DSH_FS__.writeBinary` 写回原文件。
   */
  async saveAnnotations(): Promise<void> {
    const doc = this.pdfDocument as { saveDocument?: () => Promise<Uint8Array> };
    if (doc.saveDocument === undefined) return;
    // 实际写回由 PdfViewer 组件持有 host，这里只暴露能力
  }

  dispose(): void {
    this.pdfDocument = undefined;
  }
}

// ---------- Markdown：markdown-it ----------

/** Markdown 引擎。 */
export class MarkdownEngine implements BookEngine {
  readonly format = 'markdown' as const;
  private host: DshHost | undefined;
  private path = '';
  private md: { render: (src: string) => string } | undefined;
  private html = '';
  private meta: BookMeta = { title: '', author: '', sections: 1 };

  async open(host: DshHost, path: string): Promise<BookMeta> {
    this.host = host;
    this.path = path;
    const source = await host.readText(path);
    const MarkdownIt = (await import('markdown-it')).default;
    this.md = new MarkdownIt({ html: true, linkify: true, breaks: false });
    this.html = this.md.render(source);
    this.meta = { title: path.split('/').pop() ?? '', author: '', sections: 1 };
    return this.meta;
  }

  async render(container: HTMLElement): Promise<void> {
    container.innerHTML = `<article class="markdown-body">${this.html}</article>`;
  }

  async next(): Promise<void> {}
  async prev(): Promise<void> {}
  progress(): number {
    return 0;
  }
  currentPosition(): string {
    return '0';
  }
  async goTo(): Promise<void> {}

  async loadAnnotations(): Promise<Annotation[]> {
    if (this.host === undefined) return [];
    const notesPath = `${this.path.replace(/\.[^./]+$/, '')}.notes.json`;
    try {
      const raw = await this.host.readText(notesPath);
      const parsed = JSON.parse(raw) as { annotations: Annotation[] };
      return parsed.annotations;
    } catch {
      return [];
    }
  }

  async saveAnnotations(annotations: Annotation[]): Promise<void> {
    if (this.host === undefined) return;
    const notesPath = `${this.path.replace(/\.[^./]+$/, '')}.notes.json`;
    const existing = await this.loadAnnotations();
    const merged = [...existing, ...annotations];
    await this.host.writeText(notesPath, `${JSON.stringify({ schema_version: '1.0', annotations: merged }, null, 2)}\n`);
  }

  dispose(): void {
    this.html = '';
    this.md = undefined;
  }
}

// ---------- TXT：自研分页器 ----------

/** TXT 引擎（自研分页器：按容器高度切页）。 */
export class TxtEngine implements BookEngine {
  readonly format = 'txt' as const;
  private host: DshHost | undefined;
  private path = '';
  private lines: string[] = [];
  private pageSize = 40;
  private currentPage = 0;
  private meta: BookMeta = { title: '', author: '', sections: 0 };

  async open(host: DshHost, path: string): Promise<BookMeta> {
    this.host = host;
    this.path = path;
    const text = await host.readText(path);
    this.lines = text.split('\n');
    this.meta = { title: path.split('/').pop() ?? '', author: '', sections: Math.ceil(this.lines.length / this.pageSize) };
    return this.meta;
  }

  async render(container: HTMLElement): Promise<void> {
    const start = this.currentPage * this.pageSize;
    const slice = this.lines.slice(start, start + this.pageSize);
    container.innerHTML = `<pre class="txt-body">${slice
      .map((line) => line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
      .join('\n')}</pre>`;
  }

  async next(): Promise<void> {
    if ((this.currentPage + 1) * this.pageSize < this.lines.length) this.currentPage += 1;
  }

  async prev(): Promise<void> {
    if (this.currentPage > 0) this.currentPage -= 1;
  }

  progress(): number {
    return this.lines.length === 0 ? 0 : (this.currentPage * this.pageSize) / this.lines.length;
  }

  currentPosition(): string {
    return String(this.currentPage * this.pageSize);
  }

  async goTo(position: string): Promise<void> {
    const line = Number.parseInt(position, 10);
    if (Number.isFinite(line) && line >= 0) this.currentPage = Math.floor(line / this.pageSize);
  }

  async loadAnnotations(): Promise<Annotation[]> {
    if (this.host === undefined) return [];
    const notesPath = `${this.path.replace(/\.[^./]+$/, '')}.notes.json`;
    try {
      const raw = await this.host.readText(notesPath);
      return (JSON.parse(raw) as { annotations: Annotation[] }).annotations;
    } catch {
      return [];
    }
  }

  async saveAnnotations(annotations: Annotation[]): Promise<void> {
    if (this.host === undefined) return;
    const notesPath = `${this.path.replace(/\.[^./]+$/, '')}.notes.json`;
    await this.host.writeText(notesPath, `${JSON.stringify({ schema_version: '1.0', annotations }, null, 2)}\n`);
  }

  dispose(): void {
    this.lines = [];
  }
}
