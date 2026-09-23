import type { ApiDefinition } from '@/lib/apis/list';
import { RULE_LISTS, jsRegex } from '@/lib/apis/rules';

/**
 * Path templating for the rollups' `path` dimension (ADR-0012 §5, amended
 * 2026-09-23): `/users/42` is filed as `/users/{id}`, so one endpoint is one
 * row and the per-batch cap of `MAX_PATHS_PER_BUCKET` distinct paths rarely
 * folds real endpoints into `(other)`.
 *
 * Two sources, the definition first:
 *
 * - **The API definition's named capture groups.** Every regex `pattern` the
 *   definition carries (the six rule lists, body-transform rules, and the same
 *   lists in each version override) is tried in that order against the full
 *   client path, as g2way searches it. The first pattern that matches with at
 *   least one named group (`(?P<id>\d+)` or `(?<id>\d+)`) that captured
 *   something non-empty wins, and each such group's text becomes `{name}`.
 *   Unnamed groups are ignored: `^/(v1|v2)/` captures a literal, not a
 *   parameter, and only a name says which is which. Rule `methods` are ignored
 *   too: a pattern describes the path's shape whatever the method.
 * - **A heuristic**, for every whole segment no named group covered: all
 *   digits → `{id}`, a UUID → `{uuid}`, 16 or more hex digits → `{hex}`, and a
 *   long opaque token → `{token}` (see {@link heuristicSegment}).
 *
 * Pure and universal; the cache of compiled rules at the bottom takes its
 * loader and clock as arguments, so it is tested without a gateway.
 */

/** One definition pattern that can template: it has at least one named group. */
export type TemplateRule = { regex: RegExp; names: readonly string[] };

const DIGITS = /^\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{16,}$/i;
/** Letters and digits only, 20 or more: cuid, nanoid, ULID, a hash in base36. */
const ALNUM_TOKEN = /^[A-Za-z0-9]{20,}$/;
/** base64/base64url with padding, 20 or more: only when both cases and a digit appear. */
const B64_TOKEN = /^[A-Za-z0-9_\-+=]{20,}$/;

/**
 * The placeholder for one whole path segment, or `null` to keep it. Kept
 * conservative: a slug such as `order-summary` or `v2` stays literal, and a
 * token needs a digit (and, with `-`/`_` in it, both letter cases) so a long
 * hyphenated word slug is not mistaken for one.
 */
export function heuristicSegment(segment: string): string | null {
  if (DIGITS.test(segment)) return '{id}';
  if (UUID.test(segment)) return '{uuid}';
  if (HEX.test(segment)) return '{hex}';
  const digit = /\d/.test(segment);
  if (ALNUM_TOKEN.test(segment) && digit && /[A-Za-z]/.test(segment)) return '{token}';
  if (B64_TOKEN.test(segment) && digit && /[a-z]/.test(segment) && /[A-Z]/.test(segment)) {
    return '{token}';
  }
  return null;
}

/** Every regex pattern `definition` carries, in the order they are tried. */
export function definitionPatterns(definition: ApiDefinition): string[] {
  const patterns: string[] = [];
  type Lists = Partial<Record<(typeof RULE_LISTS)[number], { pattern: string }[] | null>>;
  const fromLists = (lists: Lists) => {
    for (const list of RULE_LISTS) {
      for (const rule of lists[list] ?? []) patterns.push(rule.pattern);
    }
  };
  const fromBody = (body: ApiDefinition['transform_body']) => {
    for (const rule of [...(body?.request ?? []), ...(body?.response ?? [])]) {
      patterns.push(rule.pattern);
    }
  };
  fromLists(definition);
  fromBody(definition.transform_body);
  for (const overrides of Object.values(definition.versioning?.versions ?? {})) {
    fromLists(overrides);
    fromBody(overrides.transform_body);
  }
  return patterns;
}

/**
 * The patterns of `definition` that can template a path: those with a named
 * group that JavaScript can follow faithfully (`jsRegex`). A pattern it
 * cannot (inline flags, nested classes) is skipped, never guessed at.
 */
export function compileTemplateRules(definition: ApiDefinition): TemplateRule[] {
  const rules: TemplateRule[] = [];
  const seen = new Set<string>();
  for (const pattern of definitionPatterns(definition)) {
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    const translated = jsRegex(pattern);
    if (translated === null) continue;
    let regex: RegExp;
    try {
      // `d`: capture-group indices, to know which text each group matched.
      regex = new RegExp(translated.source, 'd');
    } catch {
      continue;
    }
    const names = [...translated.source.matchAll(/\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g)].map(
      (m) => m[1] as string,
    );
    if (names.length > 0) rules.push({ regex, names });
  }
  return rules;
}

type Span = { start: number; end: number; name: string };

/** The named-group spans of the first rule matching `path`, outermost only, in order. */
function definitionSpans(path: string, rules: readonly TemplateRule[]): Span[] {
  for (const rule of rules) {
    const match = rule.regex.exec(path);
    const indices = match?.indices?.groups;
    if (indices === undefined) continue;
    const spans = rule.names
      .flatMap((name) => {
        const at = indices[name];
        return at === undefined || at[0] === at[1] ? [] : [{ start: at[0], end: at[1], name }];
      })
      .sort((a, b) => a.start - b.start || b.end - a.end);
    const outer: Span[] = [];
    for (const span of spans) {
      const last = outer[outer.length - 1];
      if (last === undefined || span.start >= last.end) outer.push(span);
    }
    // A leading `/` must survive: the drill-down tells paths from `(other)` by it.
    const first = outer[0];
    if (first !== undefined && first.start > 0) return outer;
  }
  return [];
}

/**
 * `path` as a template: named groups of the first matching definition rule
 * first, then the heuristic on each whole segment they did not touch. A
 * segment a group covered only in part keeps its other characters literally.
 */
export function templatePath(path: string, rules: readonly TemplateRule[] = []): string {
  const spans = definitionSpans(path, rules);
  let out = '';
  let at = 0;
  const literal = (start: number, end: number) => {
    let segmentStart = start;
    for (let i = start; i <= end; i++) {
      if (i < end && path[i] !== '/') continue;
      const segment = path.slice(segmentStart, i);
      // Whole only when bounded by `/` or the ends of the path, not by a group.
      const whole =
        (segmentStart === 0 || path[segmentStart - 1] === '/') &&
        (i === path.length || path[i] === '/');
      out += (whole && segment !== '' ? heuristicSegment(segment) : null) ?? segment;
      if (i < end) out += '/';
      segmentStart = i + 1;
    }
  };
  for (const span of spans) {
    literal(at, span.start);
    out += `{${span.name}}`;
    at = span.end;
  }
  literal(at, path.length);
  return out;
}

// ---- the worker's cache of compiled rules ---------------------------------------

/** How long fetched definitions are used before the next fetch (and between failed tries). */
export const DEFINITIONS_TTL_MS = 60_000;

export type DefinitionsLoad =
  { ok: true; value: readonly ApiDefinition[] } | { ok: false; error: string };

export type TemplateRuleCache = {
  /**
   * Rules by API id: refetched when older than the TTL, the last good set
   * otherwise. Never throws: when the fetch fails, the last good set (or none,
   * so the heuristic alone) is used until the next try, a TTL later.
   */
  rules(): Promise<ReadonlyMap<string, readonly TemplateRule[]>>;
};

/**
 * A per-environment cache of compiled rules. `load` fetches the environment's
 * definitions; the worker passes `GET /g2/apis` through the server-side
 * gateway client. Fetches happen only when a batch needs templating, so an
 * idle worker never calls the gateway. A failure is logged once, and the
 * recovery once, not on every try.
 */
export function templateRuleCache(
  environment: string,
  load: () => Promise<DefinitionsLoad>,
  options: { now?: () => number; ttlMs?: number; log?: Pick<Console, 'info' | 'warn'> } = {},
): TemplateRuleCache {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? DEFINITIONS_TTL_MS;
  const log = options.log ?? console;
  let rules: ReadonlyMap<string, readonly TemplateRule[]> = new Map();
  let triedAt = -Infinity;
  let failing = false;
  return {
    async rules() {
      if (now() - triedAt < ttl) return rules;
      triedAt = now();
      let result: DefinitionsLoad;
      try {
        result = await load();
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (result.ok) {
        rules = new Map(result.value.map((api) => [api.api_id, compileTemplateRules(api)]));
        if (failing) {
          log.info(`[analytics-ingest] ${environment}: path templates from definitions again`);
        }
        failing = false;
      } else if (!failing) {
        failing = true;
        log.warn(
          `[analytics-ingest] ${environment}: API definitions unavailable, ` +
            `templating paths ${rules.size > 0 ? 'with the last ones fetched' : 'by heuristic only'}: ${result.error}`,
        );
      }
      return rules;
    },
  };
}
