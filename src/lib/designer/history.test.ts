import { describe, expect, it } from 'vitest';
import { isDraftShape } from '@/lib/apis/raw';
import { isPolicyShape } from '@/lib/policies/draft';
import { historyRows, type HistoryEntry } from './history';

const entry = (
  id: string,
  action: HistoryEntry['action'],
  definition: HistoryEntry['definition'],
) =>
  ({
    id,
    action,
    definition,
    actorEmail: 'ada@example.com',
    createdAt: '2026-09-23T10:00:00Z',
  }) satisfies HistoryEntry;

describe('historyRows (API definitions)', () => {
  const base = { api_id: 'orders', name: 'Orders', listen_path: '/v1/', target_url: 'http://up' };
  // Newest first, as listVersions returns them.
  const entries = [
    entry('v3', 'update', { ...base, listen_path: '/v3/' }),
    entry('v2', 'update', { ...base, listen_path: '/v2/' }),
    entry('v1', 'baseline', base),
  ];

  it('diffs each version against the one before it; the oldest listed has nothing to diff', () => {
    const rows = historyRows(entries, true, isDraftShape);
    expect(rows.map((r) => r.latest)).toEqual([true, false, false]);
    expect(rows.map((r) => r.hasPrevious)).toEqual([true, true, false]);
    expect(rows[0].changes).toEqual([
      { kind: 'changed', path: 'listen_path', before: '/v2/', after: '/v3/' },
    ]);
    expect(rows[2].changes).toEqual([]);
  });

  it('lets writers load any earlier version, including the baseline, but not the latest', () => {
    const rows = historyRows(entries, true, isDraftShape);
    expect(rows[0].restorable).toBeNull();
    expect(rows[1].restorable).toEqual({ ...base, listen_path: '/v2/' });
    expect(rows[2].restorable).toEqual(base);
  });

  it('lets read-only roles see every version and change, but load none', () => {
    const rows = historyRows(entries, false, isDraftShape);
    expect(rows).toHaveLength(3);
    expect(rows[0].changes).toHaveLength(1);
    expect(rows.every((r) => r.restorable === null)).toBe(true);
  });

  it('never offers a delete or a body the designer cannot edit', () => {
    const rows = historyRows(
      [
        entry('v3', 'update', base),
        entry('v2', 'delete', null),
        entry('v1', 'create', { api_id: 1 }),
      ],
      true,
      isDraftShape,
    );
    expect(rows.map((r) => r.restorable)).toEqual([null, null, null]);
  });
});

describe('historyRows (policies)', () => {
  const p1 = { policy_id: 'gold', name: 'Gold', rate: 100, per: 60 };
  const p2 = { ...p1, rate: 500 };

  it('shows what a policy version changed and loads earlier ones for writers only', () => {
    const entries = [entry('v2', 'update', p2), entry('v1', 'create', p1)];
    const rows = historyRows(entries, true, isPolicyShape);
    expect(rows[0].changes).toEqual([{ kind: 'changed', path: 'rate', before: 100, after: 500 }]);
    expect(rows[1].restorable).toEqual(p1);
    expect(historyRows(entries, false, isPolicyShape)[1].restorable).toBeNull();
  });

  it('shows a creation as every field added, against nothing', () => {
    const rows = historyRows(
      [entry('v2', 'update', p1), entry('v1', 'delete', null), entry('v0', 'create', p1)],
      true,
      isPolicyShape,
    );
    expect(rows[0].changes.every((c) => c.kind === 'added')).toBe(true);
    expect(rows[1].changes.every((c) => c.kind === 'removed')).toBe(true);
  });
});
