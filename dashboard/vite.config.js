import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API binds to localhost; the dev server proxies /api so the browser never needs CORS.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': process.env.API_URL ?? 'http://127.0.0.1:3000' },
  },
});
