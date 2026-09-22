import { describe, expect, it } from 'vitest';
import { findOrphans } from './orphans';

const rows = [{ keyHash: 'a' }, { keyHash: 'b' }, { keyHash: 'c' }];

describe('findOrphans', () => {
  it('names the rows whose hash a successful GET /g2/keys does not list', () => {
    expect(findOrphans({ ok: true, value: ['a', 'c', 'z'] }, rows)).toEqual({
      ok: true,
      orphans: [{ keyHash: 'b' }],
    });
    expect(findOrphans({ ok: true, value: ['a', 'b', 'c'] }, rows)).toEqual({
      ok: true,
      orphans: [],
    });
  });

  it('an empty but successful list makes every row an orphan', () => {
    expect(findOrphans({ ok: true, value: [] }, rows)).toEqual({ ok: true, orphans: rows });
  });

  it('a failed list names no orphans at all, quoting the gateway', () => {
    const check = findOrphans({ ok: false, error: 'storage unavailable', status: 503 }, rows);
    expect(check).toEqual({
      ok: false,
      error: 'GET /g2/keys failed, so no key can be judged gone: storage unavailable (HTTP 503)',
    });
    expect('orphans' in check).toBe(false);
  });
});
