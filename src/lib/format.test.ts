import { describe, expect, it } from 'vitest';
import { formatAge, formatDuration } from './format';

describe('formatDuration', () => {
  it('shows the two largest units and drops zero ones', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(59)).toBe('59s');
    expect(formatDuration(60)).toBe('1m');
    expect(formatDuration(312)).toBe('5m 12s');
    expect(formatDuration(3_600 + 5)).toBe('1h');
    expect(formatDuration(3 * 86_400 + 4 * 3_600 + 59)).toBe('3d 4h');
    expect(formatDuration(86_400 + 30)).toBe('1d');
  });

  it('clamps negatives and truncates fractions', () => {
    expect(formatDuration(-5)).toBe('0s');
    expect(formatDuration(1.9)).toBe('1s');
  });
});

describe('formatAge', () => {
  it('is relative to now, and never in the future', () => {
    const now = 1_000_000 * 1000;
    expect(formatAge(1_000_000 - 12, now)).toBe('12s ago');
    expect(formatAge(1_000_000 - 3_720, now)).toBe('1h 2m ago');
    expect(formatAge(1_000_000, now)).toBe('just now');
    expect(formatAge(1_000_000 + 3, now)).toBe('just now');
  });
});
