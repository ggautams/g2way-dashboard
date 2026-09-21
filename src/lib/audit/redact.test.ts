import { describe, expect, it } from 'vitest';
import {
  MAX_SNAPSHOT_BYTES,
  REDACTED,
  REDACTED_CHANGED,
  capSnapshot,
  redactSnapshot,
} from './redact';

describe('redactSnapshot', () => {
  it('hides every secret the gateway schemas carry, at any depth', () => {
    const api = {
      api_id: 'billing',
      auth: { mode: 'jwt', secret: 'hs256-secret', header: 'Authorization' },
      transform_headers: {
        request: { add: { Authorization: 'Bearer upstream', 'X-Api-Key': 'k1', 'X-Env': 'prod' } },
      },
      graphql: { schema_sync: { headers: { authorization: 'Bearer t' }, interval_ms: 1000 } },
      cors: { allow_credentials: true },
      versioning: { key: 'x-version' },
    };
    expect(redactSnapshot(api)).toEqual({
      api_id: 'billing',
      auth: { mode: 'jwt', secret: REDACTED, header: 'Authorization' },
      transform_headers: {
        request: { add: { Authorization: REDACTED, 'X-Api-Key': REDACTED, 'X-Env': 'prod' } },
      },
      graphql: { schema_sync: { headers: { authorization: REDACTED }, interval_ms: 1000 } },
      cors: { allow_credentials: true },
      versioning: { key: 'x-version' },
    });
  });

  it('hides key-session credentials', () => {
    expect(
      redactSnapshot({
        hmac: { secret: 's' },
        basic_auth: { password_hash: '$2b$12$abc' },
        alias: 'a',
      }),
    ).toEqual({ hmac: { secret: REDACTED }, basic_auth: { password_hash: REDACTED }, alias: 'a' });
  });

  it('marks a secret that changed against the other snapshot, never showing either value', () => {
    const before = { hmac: { secret: 'old' }, auth: { secret: 'same' } };
    const after = { hmac: { secret: 'new' }, auth: { secret: 'same' } };
    expect(redactSnapshot(after, before)).toEqual({
      hmac: { secret: REDACTED_CHANGED },
      auth: { secret: REDACTED },
    });
  });

  it('walks arrays and leaves nulls alone', () => {
    expect(redactSnapshot([{ token: 't' }, { token: null }])).toEqual([
      { token: REDACTED },
      { token: null },
    ]);
  });
});

describe('capSnapshot', () => {
  it('drops an oversized snapshot with a note', () => {
    const big = 'x'.repeat(MAX_SNAPSHOT_BYTES + 1);
    const capped = capSnapshot('after', big);
    expect(capped.value).toBeNull();
    expect(capped.note).toMatch(/^after not stored: \d+ bytes/);
    expect(capSnapshot('after', { a: 1 })).toEqual({ value: { a: 1 } });
  });
});
