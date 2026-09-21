/**
 * Runs once when the server starts. Applies pending database migrations before
 * the first request, so a fresh install needs no manual step (ADR-0003).
 * Node.js runtime only: the drivers are native / TCP and cannot load on the edge.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { migrateDatabase } = await import('./lib/db');
  await migrateDatabase();
}
