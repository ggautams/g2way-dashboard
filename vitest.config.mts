import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // `server-only` throws unless resolved under the react-server condition, which
      // only Next.js sets. Tests run the server modules directly, so use its no-op entry.
      'server-only': resolve(import.meta.dirname, 'node_modules/server-only/empty.js'),
    },
  },
});
