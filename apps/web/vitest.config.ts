import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./', import.meta.url)) },
  },
  // Vite 8 transforms with oxc. tsconfig keeps `jsx: preserve` for Next.js, so
  // tests need the automatic runtime set explicitly.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    // Pure logic tests run in Node; component tests opt into jsdom per file.
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
  },
});
