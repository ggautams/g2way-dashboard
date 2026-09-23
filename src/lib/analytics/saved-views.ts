import { formatUtcMinute, readCustomWindow } from './custom-range';
import { DIMENSION_LABELS, drillParams, parseDrill, type DrillState } from './drill';
import { TRAFFIC_RANGES, parseTrafficRange, type TrafficSource } from './traffic';

/**
 * Saved `/analytics` views (ADR-0016): the pure half. A view is a name for
 * the canonical query string of a view (`drillParams`), so opening one is
 * following a link, and the page re-validates it like any URL. Universal:
 * the save form's client component imports the limits and the form state.
 */

export const MAX_VIEW_NAME = 80;
/** Views one person may keep per environment (ADR-0016 §4). */
export const MAX_VIEWS_PER_OWNER = 50;
/** A canonical query is short; anything longer was not made by the page. */
export const MAX_VIEW_QUERY = 2048;

export type SavedViewFormState = { error: string | null; notice?: string };
export const INITIAL_SAVED_VIEW_FORM_STATE: SavedViewFormState = { error: null };

const CONTROL = /[\u0000-\u001f\u007f]/;

/** A view's name: trimmed, 1 to 80 characters, no control characters. */
export function parseViewName(
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'the view needs a name' };
  const value = raw.trim();
  if (value === '') return { ok: false, error: 'the view needs a name' };
  if (value.length > MAX_VIEW_NAME) {
    return { ok: false, error: `a name is at most ${MAX_VIEW_NAME} characters` };
  }
  if (CONTROL.test(value)) return { ok: false, error: 'a name cannot hold control characters' };
  return { ok: true, value };
}

/**
 * The canonical form of a submitted `/analytics` query: parsed the way the
 * page parses it, then written back by `drillParams`, so the stored string
 * always names its source (when not the default) and either a fixed range id
 * (relative) or a `from`/`to` window (absolute). Without `keys:read`, key
 * parameters are dropped, as the page drops them. A malformed window is
 * refused; everything else falls back as the page falls back.
 */
export function canonicalViewQuery(
  query: string,
  options: { keys: boolean },
): { ok: true; query: string; state: DrillState } | { ok: false; error: string } {
  if (query.length > MAX_VIEW_QUERY) return { ok: false, error: 'the view’s address is too long' };
  const params = Object.fromEntries(new URLSearchParams(query.replace(/^\?/, '')));
  const source: TrafficSource = params.source === 'prometheus' ? 'prometheus' : 'rollups';
  const drill = parseDrill(params, { keys: options.keys, source });
  const custom = readCustomWindow(params.from, params.to);
  if (custom !== null && 'problem' in custom) return { ok: false, error: custom.problem };
  if (custom !== null && custom.window.to <= custom.window.from) {
    return { ok: false, error: 'the custom range ends before it starts' };
  }
  const state: DrillState = {
    range: custom?.window ?? parseTrafficRange(params.range, source).id,
    ...(source === 'prometheus' ? { source } : {}),
    apiId: drill.apiId,
    focus: drill.focus,
    by: drill.by,
  };
  return { ok: true, query: new URLSearchParams(drillParams(state)).toString(), state };
}

/** Where a saved view opens. */
export function viewHref(query: string): string {
  return `/analytics?${query}`;
}

/** How a saved view is listed: its range (relative or absolute), source and selection. */
export type ViewSummary = {
  range: string;
  /** A custom window: the same traffic whenever it is opened. */
  absolute: boolean;
  source: TrafficSource;
  /** `API users`, `Status 5xx`, `by Path`: what the view narrows to and splits by. */
  selection: string[];
};

/** Reads a stored query back for the list. Nothing here is trusted: the page re-checks on open. */
export function describeViewQuery(query: string): ViewSummary {
  const params = new URLSearchParams(query);
  const source: TrafficSource = params.get('source') === 'prometheus' ? 'prometheus' : 'rollups';
  const custom = readCustomWindow(params.get('from') ?? undefined, params.get('to') ?? undefined);
  const selection: string[] = [];
  const api = params.get('api');
  if (api !== null && api !== '') selection.push(`API ${api}`);
  for (const dimension of ['key', 'status', 'method', 'path'] as const) {
    const value = params.get(dimension);
    if (value === null) continue;
    selection.push(
      dimension === 'key'
        ? value === ''
          ? 'No key'
          : 'One key'
        : `${DIMENSION_LABELS[dimension]} ${value}`,
    );
  }
  const by = params.get('by');
  if (by !== null && Object.hasOwn(DIMENSION_LABELS, by)) {
    selection.push(`by ${DIMENSION_LABELS[by as keyof typeof DIMENSION_LABELS]}`);
  }
  if (custom !== null && 'window' in custom) {
    const at = (ms: number) => formatUtcMinute(ms).replace('T', ' ');
    return {
      range: `${at(custom.window.from)} to ${at(custom.window.to)} UTC`,
      absolute: true,
      source,
      selection,
    };
  }
  return {
    range: TRAFFIC_RANGES[parseTrafficRange(params.get('range'), source).id].label,
    absolute: false,
    source,
    selection,
  };
}
