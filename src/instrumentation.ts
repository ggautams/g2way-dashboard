/**
 * Runs once when the server starts. Applies pending database migrations before
 * the first request, so a fresh install needs no manual step (ADR-0003), then
 * starts the analytics ingest worker when an environment names a Redis URL
 * (ADR-0012; `G2_ANALYTICS_INGEST=off` leaves it to `npm run ingest`).
 * Node.js runtime only: the drivers are native / TCP and cannot load on the edge.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { migrateDatabase } = await import('./lib/db');
  await migrateDatabase();
  const { startServerIngestWorker } = await import('./lib/analytics/worker');
  startServerIngestWorker();
}
