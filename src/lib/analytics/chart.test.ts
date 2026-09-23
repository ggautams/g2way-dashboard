import { describe, expect, it } from 'vitest';
import {
  formatTick,
  formatTickValue,
  formatTimestamp,
  formatValue,
  niceTicks,
  timeTicks,
} from './chart';

describe('niceTicks', () => {
  it('rounds the top up to a nice step', () => {
    expect(niceTicks(7.3)).toEqual({ max: 8, ticks: [0, 2, 4, 6, 8] });
    expect(niceTicks(100)).toEqual({ max: 100, ticks: [0, 25, 50, 75, 100] });
    expect(niceTicks(0.037)).toEqual({ max: 0.04, ticks: [0, 0.01, 0.02, 0.03, 0.04] });
    expect(niceTicks(1234).max).toBe(1500);
  });

  it('gives an empty series a unit axis', () => {
    expect(niceTicks(0).max).toBe(1);
    expect(niceTicks(Number.NaN).max).toBe(1);
  });
});

describe('timeTicks', () => {
  const from = Date.UTC(2026, 8, 23, 9, 31);
  it('aligns ticks to UTC and keeps them few', () => {
    const ticks = timeTicks(from, from + 3_600_000);
    expect(ticks.length).toBeLessThanOrEqual(6);
    expect(ticks.map((t) => formatTick(t, 3_600_000))).toEqual([
      '09:40',
      '09:50',
      '10:00',
      '10:10',
      '10:20',
      '10:30',
    ]);
  });

  it('labels multi-day spans with dates', () => {
    const span = 7 * 86_400_000;
    const ticks = timeTicks(from, from + span);
    expect(ticks.length).toBeLessThanOrEqual(6);
    expect(formatTick(Date.UTC(2026, 8, 24), span)).toBe('Sep 24');
    expect(formatTick(Date.UTC(2026, 8, 24, 6), span)).toBe('Sep 24 06:00');
  });

  it('formats a full timestamp in UTC', () => {
    expect(formatTimestamp(Date.UTC(2026, 8, 23, 4, 5))).toBe('Sep 23 04:05 UTC');
  });
});

describe('formatValue', () => {
  it('formats each unit, and no data as a dash', () => {
    expect(formatValue(null, 'ms')).toBe('—');
    expect(formatValue(0.5, 'rps')).toBe('0.50');
    expect(formatValue(1234.4, 'rps')).toBe('1,234');
    expect(formatValue(0.0512, 'percent')).toBe('5.1%');
    expect(formatValue(0.00012, 'percent')).toBe('0.01%');
    expect(formatValue(0, 'percent')).toBe('0%');
    expect(formatValue(2.54, 'ms')).toBe('2.5 ms');
    expect(formatValue(312.6, 'ms')).toBe('313 ms');
    expect(formatValue(2500, 'ms')).toBe('2.50 s');
  });

  it('formats ticks with the decimals the step needs', () => {
    expect(formatTickValue(0.025, 0.025, 'percent')).toBe('2.5%');
    expect(formatTickValue(2000, 1000, 'ms')).toBe('2 s');
    expect(formatTickValue(250, 250, 'ms')).toBe('250 ms');
    expect(formatTickValue(0.5, 0.5, 'rps')).toBe('0.5');
  });
});
