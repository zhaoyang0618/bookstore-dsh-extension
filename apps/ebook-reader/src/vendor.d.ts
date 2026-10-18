/**
 * 前端用到的第三方模块声明（这些包没有官方类型）。
 *
 * @module ebook-reader/vendor
 */

declare module 'foliate-js/view.js' {
  export function makeBook(file: Blob | ArrayBuffer): Promise<unknown>;
  export class FoliateView {
    constructor(element: HTMLElement, book: unknown);
    next(): void;
    prev(): void;
    goTo(target: string): void;
    destroy(): void;
  }
}

declare module '*.css';
