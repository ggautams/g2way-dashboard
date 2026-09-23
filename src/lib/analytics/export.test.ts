import { describe, expect, it } from 'vitest';
import { exportMeta, sourceNote } from './export';
import { TRAFFIC_RANGES } from './traffic';

const NOW = Date.parse('2026-09-23T12:00:30Z');
const TARGET = { id: 'prod', label: 'Production' };
const DRILL = {
  apiId: 'users',
  focus: { dimension: 'status', value: '5xx' },
  by: 'status',
} as const;

describe('exportMeta', () => {
  it('describes the view the file holds', () => {
    const meta = exportMeta(
      TARGET,
      { source: 'rollups', range: TRAFFIC_RANGES['1h'], drill: { ...DRILL, notes: [] }, notes: [] },
      'breakdown',
      NOW,
    );
    expect(Object.fromEntries(meta.filter(([name]) => name !== 'note'))).toEqual({
      'g2way-dashboard traffic export': 'breakdown',
      environment: 'Production (prod)',
      source: 'rollups',
      range: 'last hour',
      from_utc: '2026-09-23T11:01:00.000Z',
      to_utc: '2026-09-23T12:01:00.000Z',
      step_seconds: '60',
      api: 'users',
      status: '5xx',
      breakdown: 'status',
      exported_at_utc: '2026-09-23T12:00:30.000Z',
    });
    const notes = meta.filter(([name]) => name === 'note').map(([, value]) => value);
    expect(notes[0]).toBe(sourceNote('rollups'));
    expect(notes[1]).toMatch(/still filling/);
  });

  it('says that Prometheus counts are rounded increase() values with no maximum', () => {
    const meta = exportMeta(
      TARGET,
      {
        source: 'prometheus',
        range: TRAFFIC_RANGES['30d'],
        drill: { ...DRILL, notes: [] },
        notes: ['method: ignored'],
      },
      'series',
      NOW,
    );
    const notes = meta.filter(([name]) => name === 'note').map(([, value]) => value);
    expect(notes[0]).toMatch(/increase\(\).*rounded/);
    expect(notes[0]).toMatch(/no maximum, so latency_max_ms is empty/);
    expect(notes).toContain('method: ignored');
    expect(meta.some(([name]) => name === 'breakdown')).toBe(false);
  });
});
