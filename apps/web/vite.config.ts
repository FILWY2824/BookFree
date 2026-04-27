import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config. Build output goes to dist/, which is what the Go
// embed directive expects after `cp -r dist/* server/webdist/`.
//
// In dev (`npm run dev`), Vite runs on port 5173 and proxies /api/*
// to the Go server. The default dev `BOOKFREE_ADDR` is 127.0.0.1:3001
// (see server/internal/config/config.go); the Docker image overrides
// to 0.0.0.0:8788. We point at the dev default and tell operators to
// override with VITE_API_TARGET when running against a non-default
// backend.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Code-split aggressively so the initial shell stays small. Reader
    // libraries (epub.js, pdf.js, foliate-js) are only loaded when the
    // user opens a book of that format, or starts uploading one.
    rollupOptions: {
      output: {
        manualChunks: {
          react:    ['react', 'react-dom', 'react-router-dom'],
          pdf:      ['pdfjs-dist'],
          epub:     ['epubjs'],
          // Parser bundle: foliate-js + the zip/inflate primitives it
          // needs. This is the chunk that loads when the user picks a
          // .mobi/.azw/.azw3/.fb2/.fbz/.cbz/.epub file to upload.
          // Keeping it separate from the rendering chunks (epub, pdf)
          // means a TXT-only user never pays for it.
          parsers:  ['foliate-js/mobi.js', 'foliate-js/fb2.js',
                     'foliate-js/comic-book.js', 'foliate-js/epub.js',
                     '@zip.js/zip.js', 'fflate'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3001',
        changeOrigin: false,
        ws: false,
      },
    },
  },
});
