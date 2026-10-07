import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  worker: { format: 'es' },
  optimizeDeps: {
    // transformers.js ships its own wasm loader; prebundling breaks it.
    exclude: ['@huggingface/transformers', '@mediabunny/aac-encoder'],
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        'export-test': resolve(import.meta.dirname, 'export-test.html'),
      },
    },
  },
});
