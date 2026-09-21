import { describe, expect, it } from 'vitest';
import { AUDIT_PAGE_SIZE, auditQueryString, parseAuditQuery } from './query';

describe('parseAuditQuery', () => {
  it('turns the form fields into a filter, with to including its whole day', () => {
    const parsed = parseAuditQuery({
      actor: ' Ada@Example.com ',
      action: 'api.',
      target: 'httpbin',
      outcome: 'denied',
      from: '2026-09-01',
      to: '2026-09-23',
      page: '3',
    });
    expect(parsed.filter).toEqual({
      actor: 'ada@example.com',
      action: 'api.',
      target: 'httpbin',
      outcome: 'denied',
      from: new Date('2026-09-01T00:00:00Z'),
      to: new Date('2026-09-24T00:00:00Z'),
    });
    expect(parsed.offset).toBe(2 * AUDIT_PAGE_SIZE);
    expect(parsed.problems).toEqual([]);
  });

  it('ignores bad input and says why', () => {
    const parsed = parseAuditQuery({ outcome: 'maybe', from: '2026-02-30', page: '-1' });
    expect(parsed.filter).toEqual({});
    expect(parsed.query.page).toBe(1);
    expect(parsed.problems).toEqual([
      'unknown outcome "maybe"',
      '"2026-02-30" is not a date (YYYY-MM-DD)',
    ]);
  });

  it('takes the first of repeated parameters', () => {
    expect(parseAuditQuery({ action: ['a', 'b'] }).filter).toEqual({ action: 'a' });
  });
});

describe('auditQueryString', () => {
  it('round-trips the set fields and the page', () => {
    const { query } = parseAuditQuery({ action: 'key.', outcome: 'failure' });
    expect(auditQueryString(query, 2)).toBe('?action=key.&outcome=failure&page=2');
    expect(auditQueryString(parseAuditQuery({}).query, 1)).toBe('');
  });
});
