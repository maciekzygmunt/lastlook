import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // Dev-only: the real server (npx lastlook) serves the built UI itself
    proxy: {
      '/api': 'http://localhost:4700',
    },
  },
});
