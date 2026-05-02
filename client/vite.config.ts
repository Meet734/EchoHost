import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@echohost/shared': path.resolve(__dirname, '../shared/types/index.ts'),
    },
    extensions: ['.mts', '.ts', '.mtsx', '.tsx', '.mjs', '.js', '.mjs', '.cjs', '.json'],
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
