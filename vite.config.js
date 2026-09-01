import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendUrl = process.env.RALLY_BACKEND_URL || 'http://localhost:3100';

export default defineConfig({
  root: 'public',
  publicDir: false,
  base: '/',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2020'
  },
  server: {
    port: 5173,
    proxy: {
      '/data': { target: backendUrl },
      '/socket.io': { target: backendUrl, ws: true }
    }
  },
  resolve: {
    alias: {
      shared: path.resolve(__dirname, 'shared')
    }
  }
});
