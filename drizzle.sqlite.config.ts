import { defineConfig } from 'drizzle-kit';
import { parseDatabaseUrl } from './src/lib/db/config';

// `npm run db:generate` writes SQLite migrations from this config. ADR-0003.
const config = parseDatabaseUrl(process.env);

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/lib/db/schema/sqlite.ts',
  out: './drizzle/sqlite',
  dbCredentials: { url: config.dialect === 'sqlite' ? config.path : ':memory:' },
});
