// `npm run ingest`: the analytics ingest worker as its own process (ADR-0012 §2),
// for deployments that keep it apart from the web tier (set
// G2_ANALYTICS_INGEST=off on the server then). Same loop the server runs.
// Applies pending migrations first, so it can start before the server does.
// Runs until SIGINT/SIGTERM, then finishes the batch in hand.
// Run under `--conditions=react-server` so the modules' `server-only` guard loads.
import { parseIngestConfig } from '../src/lib/analytics/config';
import { startIngestWorker } from '../src/lib/analytics/worker';
import { getDatabase, migrateDatabase } from '../src/lib/db';

const database = getDatabase();
await migrateDatabase(database);
// G2_ANALYTICS_INGEST only decides whether the *server* runs the loop.
const config = { ...parseIngestConfig(process.env), inServer: false };
const worker = startIngestWorker({ config });
if (worker === null) {
  await database.close();
  process.exit(1);
}

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.info(`[analytics-ingest] ${signal}: finishing the batch in hand`);
  await worker!.stop();
  await database.close();
  process.exit(0);
}
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
