// `npm run db:migrate`: apply pending migrations to DATABASE_URL's database —
// the same code path the server runs at startup (src/instrumentation.ts).
// Run under `--conditions=react-server` so the db module's `server-only` guard loads.
import { getDatabase, migrateDatabase } from '../src/lib/db';

const database = getDatabase();
try {
  await migrateDatabase(database);
  console.log(`db:migrate — ${database.dialect} database is up to date`);
} finally {
  await database.close();
}
