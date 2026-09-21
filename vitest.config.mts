import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    // The first PGlite handle in each worker compiles Postgres' WASM build, which
    // under a full parallel run can take longer than the 5s default on its own.
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      // tsconfig's `@/*` path, as Next.js resolves it.
      '@/': resolve(import.meta.dirname, 'src') + '/',
      // `server-only` throws unless resolved under the react-server condition, which
      // only Next.js sets. Tests run the server modules directly, so use its no-op entry.
      'server-only': resolve(import.meta.dirname, 'node_modules/server-only/empty.js'),
    },
  },
});
