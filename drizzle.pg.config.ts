import { defineConfig } from 'drizzle-kit';
import { parseDatabaseUrl } from './src/lib/db/config';

// `npm run db:generate` writes Postgres migrations from this config. ADR-0003.
// Generating needs no server; `url` matters only for drizzle-kit's live commands.
const config = parseDatabaseUrl(process.env);

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/lib/db/schema/pg.ts',
  out: './drizzle/pg',
  dbCredentials: { url: config.dialect === 'postgres' ? config.url : 'postgres://localhost/g2way' },
});
