import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The Electron shell loads dist/ through the vvapp:// scheme (root-relative URLs work there).
// In development, set VV_DEV_URL to the Vite server URL before starting Electron.
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome130',
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
