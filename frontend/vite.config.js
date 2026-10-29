// Vue 3 前端工程：Vite 用于开发与生产构建，开发时 API 代理到本地服务。
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8090',
      '/img': 'http://127.0.0.1:8090',
      '/console-legacy.html': 'http://127.0.0.1:8090',
      '/favicon.svg': 'http://127.0.0.1:8090',
      '/favicon.ico': 'http://127.0.0.1:8090',
      '/apple-touch-icon.png': 'http://127.0.0.1:8090',
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
  },
});
