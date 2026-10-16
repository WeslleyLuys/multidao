import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: ['es2022', 'safari15', 'chrome96', 'firefox100'], // top-level await em main.ts; iOS 15+
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
});
