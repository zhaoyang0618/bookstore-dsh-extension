import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  // 设计文档 2.4：EPUB 用 foliate-js，PDF 用 PDF.js
  optimizeDeps: {
    include: ['foliate-js', 'pdfjs-dist'],
  },
});
