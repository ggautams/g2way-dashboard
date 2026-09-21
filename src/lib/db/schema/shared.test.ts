import { describe, expect, it } from 'vitest';
import { monotonicUuid } from './shared';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('monotonicUuid', () => {
  it('is a UUIDv7 carrying the millisecond it was made in', () => {
    const now = Date.UTC(2026, 8, 23, 12, 0, 0, 123);
    const id = monotonicUuid(now + 10_000);
    expect(id).toMatch(UUID_V7);
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(now + 10_000);
  });

  it('strictly increases as text within one millisecond, past the counter’s range', () => {
    const now = Date.now() + 60_000;
    const ids = Array.from({ length: 5000 }, () => monotonicUuid(now));
    for (let i = 1; i < ids.length; i += 1) expect(ids[i] > ids[i - 1], `${i}`).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps increasing when the clock steps back', () => {
    const now = Date.now() + 120_000;
    const later = monotonicUuid(now);
    const earlier = monotonicUuid(now - 5_000);
    expect(earlier > later).toBe(true);
  });
});
