import { describe, expect, it } from 'vitest';
import { DEFAULT_SQLITE_PATH, DatabaseConfigError, parseDatabaseUrl } from './config';

describe('parseDatabaseUrl', () => {
  it('defaults to SQLite under ./data when DATABASE_URL is unset or blank', () => {
    expect(parseDatabaseUrl({})).toEqual({ dialect: 'sqlite', path: DEFAULT_SQLITE_PATH });
    expect(parseDatabaseUrl({ DATABASE_URL: '  ' })).toEqual({
      dialect: 'sqlite',
      path: DEFAULT_SQLITE_PATH,
    });
  });

  it.each([
    ['file:./var/dash.db', './var/dash.db'],
    ['file:/srv/dash.db', '/srv/dash.db'],
    ['file:///srv/dash.db', '/srv/dash.db'],
    ['file::memory:', ':memory:'],
  ])('reads %s as a SQLite path', (url, path) => {
    expect(parseDatabaseUrl({ DATABASE_URL: url })).toEqual({ dialect: 'sqlite', path });
  });

  it.each(['postgres://dash:pw@db:5432/dash', 'postgresql://db/dash?sslmode=require'])(
    'reads %s as Postgres, keeping the URL intact',
    (url) => {
      expect(parseDatabaseUrl({ DATABASE_URL: url })).toEqual({ dialect: 'postgres', url });
    },
  );

  it('rejects other schemes without echoing the value', () => {
    const secretish = 'mysql://root:hunter2@db/dash';
    expect(() => parseDatabaseUrl({ DATABASE_URL: secretish })).toThrow(DatabaseConfigError);
    try {
      parseDatabaseUrl({ DATABASE_URL: secretish });
    } catch (error) {
      expect(String(error)).not.toContain('hunter2');
    }
  });

  it('rejects an empty file: path', () => {
    expect(() => parseDatabaseUrl({ DATABASE_URL: 'file:' })).toThrow(/names no file/);
  });
});
