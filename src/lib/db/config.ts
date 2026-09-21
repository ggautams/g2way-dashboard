/**
 * Which database the dashboard uses, from `DATABASE_URL`. See ADR-0003.
 *
 * Pure and free of `server-only` so the drizzle-kit configs can load it too; the
 * connection itself is opened only by `index.ts`, which is server-only.
 *
 * - unset → SQLite at `./data/dashboard.db`
 * - `file:<path>` → SQLite at `<path>` (`file::memory:` for an in-memory database)
 * - `postgres://…` or `postgresql://…` → Postgres
 */

export const DEFAULT_SQLITE_PATH = './data/dashboard.db';

export type DatabaseConfig =
  | { dialect: 'sqlite'; /** A file path, or `:memory:`. */ path: string }
  | { dialect: 'postgres'; url: string };

/** `DATABASE_URL` is unusable. Never echoes the value: a Postgres URL carries a password. */
export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(`DATABASE_URL ${message}`);
    this.name = 'DatabaseConfigError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

export function parseDatabaseUrl(env: Env): DatabaseConfig {
  const raw = env.DATABASE_URL?.trim();
  if (!raw) return { dialect: 'sqlite', path: DEFAULT_SQLITE_PATH };

  if (/^postgres(ql)?:\/\//i.test(raw)) {
    try {
      new URL(raw);
    } catch {
      throw new DatabaseConfigError('is not a valid postgres:// URL');
    }
    return { dialect: 'postgres', url: raw };
  }

  if (raw.toLowerCase().startsWith('file:')) {
    // Accept `file:./x.db`, `file:/abs/x.db` and `file:///abs/x.db`.
    const path = raw.slice('file:'.length).replace(/^\/\/(?=\/)/, '');
    if (path === '') throw new DatabaseConfigError('names no file after "file:"');
    return { dialect: 'sqlite', path };
  }

  throw new DatabaseConfigError(
    'must start with file: (SQLite) or postgres:// / postgresql:// (Postgres)',
  );
}
