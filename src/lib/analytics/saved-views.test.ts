import { describe, expect, it } from 'vitest';
import {
  MAX_VIEW_NAME,
  canonicalViewQuery,
  describeViewQuery,
  parseViewName,
  viewHref,
} from './saved-views';

describe('parseViewName', () => {
  it('trims, and refuses empty, long and control-character names', () => {
    expect(parseViewName('  Checkout 5xx ')).toEqual({ ok: true, value: 'Checkout 5xx' });
    expect(parseViewName('   ').ok).toBe(false);
    expect(parseViewName(null).ok).toBe(false);
    expect(parseViewName('x'.repeat(MAX_VIEW_NAME + 1)).ok).toBe(false);
    expect(parseViewName('a\nb').ok).toBe(false);
  });
});

describe('canonicalViewQuery', () => {
  it('writes the view back in the fixed order, with its default breakdown', () => {
    const result = canonicalViewQuery('?by=path&api=users&range=24h', { keys: true });
    expect(result).toMatchObject({ ok: true, query: 'range=24h&api=users&by=path' });
    expect(canonicalViewQuery('', { keys: true })).toMatchObject({ query: 'range=1h&by=api' });
  });

  it('keeps the source and a relative or absolute range', () => {
    expect(canonicalViewQuery('source=prometheus&range=90d', { keys: true })).toMatchObject({
      query: 'range=90d&source=prometheus&by=api',
    });
    expect(
      canonicalViewQuery('from=2026-09-01T00:00&to=2026-09-02T00:00&status=5xx', { keys: true }),
    ).toMatchObject({
      query: 'from=2026-09-01T00%3A00&to=2026-09-02T00%3A00&status=5xx&by=api',
    });
  });

  it('falls back as the page does, and drops key parameters without keys:read', () => {
    expect(canonicalViewQuery('range=90d&method=GET', { keys: true })).toMatchObject({
      query: 'range=1h&method=GET&by=api',
    });
    expect(canonicalViewQuery(`key=${'a'.repeat(64)}`, { keys: false })).toMatchObject({
      query: 'range=1h&by=api',
    });
  });

  it('keeps 90d from the rollups where hour retention holds it', () => {
    expect(
      canonicalViewQuery('range=90d&method=GET', { keys: true, hourRetentionDays: 90 }),
    ).toMatchObject({ query: 'range=90d&method=GET&by=api' });
    expect(describeViewQuery('range=90d', 90).range).toBe('Last 90 days');
    expect(describeViewQuery('range=90d').range).toBe('Last hour');
  });

  it('refuses a malformed or inverted window, and an overlong query', () => {
    expect(canonicalViewQuery('from=2026-09-01T00:00', { keys: true }).ok).toBe(false);
    expect(canonicalViewQuery('from=2026-09-02T00:00&to=2026-09-01T00:00', { keys: true }).ok).toBe(
      false,
    );
    expect(canonicalViewQuery(`api=${'x'.repeat(3000)}`, { keys: true }).ok).toBe(false);
  });
});

describe('describeViewQuery', () => {
  it('describes a relative view', () => {
    expect(describeViewQuery('range=24h&api=users&status=5xx&by=api')).toEqual({
      range: 'Last 24 hours',
      absolute: false,
      source: 'rollups',
      selection: ['API users', 'Status 5xx', 'by API'],
    });
  });

  it('describes an absolute Prometheus view, never showing a key hash', () => {
    expect(
      describeViewQuery(
        `from=2026-09-01T00%3A00&to=2026-09-02T00%3A00&source=prometheus&key=${'a'.repeat(64)}&by=toString`,
      ),
    ).toEqual({
      range: '2026-09-01 00:00 to 2026-09-02 00:00 UTC',
      absolute: true,
      source: 'prometheus',
      selection: ['One key'],
    });
  });

  it('opens on /analytics', () => {
    expect(viewHref('range=1h')).toBe('/analytics?range=1h');
  });
});
