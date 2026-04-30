import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@echohost/shared': path.resolve(__dirname, '../shared/types/index.ts'),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
