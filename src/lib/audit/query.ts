import { AUDIT_OUTCOMES, type AuditOutcome } from '@/lib/db/schema/shared';

/**
 * The audit page's URL query: parsed into a filter for `listAudit` and written
 * back for pagination links. Universal and pure. Dates are whole UTC days
 * (`YYYY-MM-DD`, what `<input type="date">` submits); `to` includes its day.
 */

export type AuditQuery = {
  actor: string;
  action: string;
  target: string;
  outcome: AuditOutcome | '';
  from: string;
  to: string;
  page: number;
};

export type ParsedAuditQuery = {
  query: AuditQuery;
  /** What `listAudit` takes. */
  filter: {
    actor?: string;
    action?: string;
    target?: string;
    outcome?: AuditOutcome;
    from?: Date;
    to?: Date;
  };
  offset: number;
  /** Inputs that were ignored, and why. */
  problems: string[];
};

export const AUDIT_PAGE_SIZE = 50;
const MAX_FIELD = 200;

type SearchParams = Record<string, string | string[] | undefined>;

function field(params: SearchParams, name: string): string {
  const value = params[name];
  const text = Array.isArray(value) ? value[0] : value;
  return (text ?? '').trim().slice(0, MAX_FIELD);
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Midnight UTC starting `text`'s day, or `null` if it is not a real date. */
function utcDay(text: string): Date | null {
  const match = DAY.exec(text);
  if (match === null) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().startsWith(text) ? date : null;
}

export function parseAuditQuery(params: SearchParams): ParsedAuditQuery {
  const problems: string[] = [];
  const outcomeText = field(params, 'outcome');
  const outcome = (AUDIT_OUTCOMES as readonly string[]).includes(outcomeText)
    ? (outcomeText as AuditOutcome)
    : '';
  if (outcomeText !== '' && outcome === '') problems.push(`unknown outcome "${outcomeText}"`);

  const pageNumber = Number.parseInt(field(params, 'page') || '1', 10);
  const page = Number.isSafeInteger(pageNumber) && pageNumber >= 1 ? pageNumber : 1;

  const query: AuditQuery = {
    actor: field(params, 'actor'),
    action: field(params, 'action'),
    target: field(params, 'target'),
    outcome,
    from: field(params, 'from'),
    to: field(params, 'to'),
    page,
  };

  const filter: ParsedAuditQuery['filter'] = {};
  if (query.actor) filter.actor = query.actor.toLowerCase();
  if (query.action) filter.action = query.action;
  if (query.target) filter.target = query.target;
  if (outcome) filter.outcome = outcome;
  for (const bound of ['from', 'to'] as const) {
    if (query[bound] === '') continue;
    const day = utcDay(query[bound]);
    if (day === null) {
      problems.push(`"${query[bound]}" is not a date (YYYY-MM-DD)`);
      query[bound] = '';
      continue;
    }
    filter[bound] = bound === 'to' ? new Date(day.getTime() + 86_400_000) : day;
  }

  return { query, filter, offset: (page - 1) * AUDIT_PAGE_SIZE, problems };
}

/** The query string for `query` at `page` (empty fields left out). */
export function auditQueryString(query: AuditQuery, page: number): string {
  const params = new URLSearchParams();
  for (const name of ['actor', 'action', 'target', 'outcome', 'from', 'to'] as const) {
    if (query[name] !== '') params.set(name, query[name]);
  }
  if (page > 1) params.set('page', String(page));
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}
