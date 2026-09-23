/**
 * g2way's middleware chain for one API, as data: which of the 19 slots a
 * definition switches on, and how a versioned API splits them.
 *
 * This mirrors the `ChainBuilder` rustdoc and its `build`, `build_outer` and
 * `build_inner` in `crates/g2-middleware/src/chain.rs` (watched as the
 * `middleware-chain` area in `contracts/watch.json`), plus
 * `VersioningConfig::apply` in `crates/g2-core/src/versioning.rs` for how a
 * version's overrides replace base fields. When the drift check flags either,
 * re-read them and update `CHAIN_SLOTS` and `chain.test.ts` together.
 *
 * Universal and pure, so the designer and its tests share it.
 */

import type { components } from '../../../contracts/g2way.d.ts';
import type { ApiDefinition } from './list';

type VersionOverrides = components['schemas']['VersionOverrides'];
type VersioningConfig = components['schemas']['VersioningConfig'];

/**
 * - `gateway`: switched by gateway process flags (tracing, metrics, stats,
 *   analytics sink), never by the definition, so the dashboard cannot know.
 * - `always`: present in every chain.
 * - `configured`: present only when the definition configures it.
 */
export type SlotKind = 'gateway' | 'always' | 'configured';

/**
 * `shared`: for a versioned API, built once around the version dispatcher
 * (`build_outer`, slots 1–7). `per-version`: built once per version around
 * that version's forwarder (`build_inner`, slots 8–19).
 */
export type SlotScope = 'shared' | 'per-version';

export type ChainSlot = {
  /** 1-based position, outermost first, as numbered in chain.rs. */
  position: number;
  /**
   * Stable id for linking (editors, the explain panel). Render anchors with
   * `chainAnchor()`, never by hand.
   */
  id: string;
  /** The Rust layer type. */
  layer: string;
  title: string;
  /** What the slot does, and why it sits where it does. */
  summary: string;
  kind: SlotKind;
  scope: SlotScope;
  /** The `ApiDefinition` fields that switch the slot on; empty unless `configured`. */
  fields: readonly (keyof ApiDefinition)[];
};

/** The 19 slots, outermost first, exactly as chain.rs composes them. */
export const CHAIN_SLOTS: readonly ChainSlot[] = [
  {
    position: 1,
    id: 'trace',
    layer: 'TraceLayer',
    title: 'Tracing span',
    summary: 'Opens the per-request tracing span; every slot below runs inside it.',
    kind: 'gateway',
    scope: 'shared',
    fields: [],
  },
  {
    position: 2,
    id: 'metrics',
    layer: 'MetricsLayer',
    title: 'Metrics',
    summary: 'Records the per-request duration histogram sample.',
    kind: 'gateway',
    scope: 'shared',
    fields: [],
  },
  {
    position: 3,
    id: 'stats',
    layer: 'StatsLayer',
    title: 'Stats counters',
    summary: 'Counts requests per API. Above auth, so rejections count too.',
    kind: 'gateway',
    scope: 'shared',
    fields: [],
  },
  {
    position: 4,
    id: 'analytics',
    layer: 'AnalyticsLayer',
    title: 'Analytics record',
    summary: 'Writes one analytics record per request. Above auth, so rejections are recorded.',
    kind: 'gateway',
    scope: 'shared',
    fields: [],
  },
  {
    position: 5,
    id: 'set-context',
    layer: 'SetContextLayer',
    title: 'Request context',
    summary: 'Stamps the API id and org id on the request for every slot below.',
    kind: 'always',
    scope: 'shared',
    fields: [],
  },
  {
    position: 6,
    id: 'ip-filter',
    layer: 'IpFilterLayer',
    title: 'IP allow/deny',
    summary:
      'Rejects clients by peer IP with 403. Outermost policy: a blocked client gets no CORS headers, path evaluation or credential work.',
    kind: 'configured',
    scope: 'shared',
    fields: ['allow_ips', 'block_ips'],
  },
  {
    position: 7,
    id: 'cors',
    layer: 'CorsLayer',
    title: 'CORS',
    summary:
      'Answers preflights and decorates responses. Above auth, so preflights need no credentials and 401/403/429 still carry CORS headers.',
    kind: 'configured',
    scope: 'shared',
    fields: ['cors'],
  },
  {
    position: 8,
    id: 'path-policy',
    layer: 'PathPolicyLayer',
    title: 'Path allow/block/ignore-auth',
    summary:
      'Rejects blocked or non-allowed paths before any credential work, and tells auth to stand down on ignored paths.',
    kind: 'configured',
    scope: 'per-version',
    fields: ['allow_paths', 'block_paths', 'ignore_auth_paths'],
  },
  {
    position: 9,
    id: 'size-limit',
    layer: 'RequestSizeLimitLayer',
    title: 'Request size limit',
    summary: 'Rejects bodies over the limit with 413, before any credential work.',
    kind: 'configured',
    scope: 'per-version',
    fields: ['max_request_body_bytes'],
  },
  {
    position: 10,
    id: 'plugins-pre',
    layer: 'PluginLayer',
    title: 'Pre plugins',
    summary:
      'WASM pre hooks, directly above auth so they can inject or transform credentials. Their short-circuits still get CORS headers.',
    kind: 'configured',
    scope: 'per-version',
    fields: ['plugins'],
  },
  {
    position: 11,
    id: 'auth',
    layer: 'AuthLayer',
    title: 'Authentication',
    summary: 'Resolves the credential to a session. Absent only for keyless APIs.',
    kind: 'configured',
    scope: 'per-version',
    fields: ['auth'],
  },
  {
    position: 12,
    id: 'rate-limit',
    layer: 'RateLimitLayer',
    title: 'Rate limits and quota',
    summary:
      'Endpoint rate limits (all clients combined) plus the session rate and quota; excess gets 429.',
    kind: 'configured',
    scope: 'per-version',
    fields: ['auth', 'endpoint_rate_limits'],
  },
  {
    position: 13,
    id: 'plugins-post',
    layer: 'PluginLayer',
    title: 'Post plugins',
    summary:
      'WASM post hooks. They see the authenticated session; 401/403/429 rejections never reach them.',
    kind: 'configured',
    scope: 'per-version',
    fields: ['plugins'],
  },
  {
    position: 14,
    id: 'graphql',
    layer: 'GraphQlLayer',
    title: 'GraphQL',
    summary:
      'Schema validation, depth and introspection limits, field grants, the playground and persisted queries. In udg mode it answers requests itself.',
    kind: 'configured',
    scope: 'per-version',
    fields: ['graphql'],
  },
  {
    position: 15,
    id: 'transform-headers',
    layer: 'HeaderTransformLayer',
    title: 'Header transforms',
    summary:
      'Adds and removes request and response headers. Gateway rejections above are never transformed.',
    kind: 'configured',
    scope: 'per-version',
    fields: ['transform_headers'],
  },
  {
    position: 16,
    id: 'transform-body',
    layer: 'BodyTransformLayer',
    title: 'Body transforms',
    summary: 'Minijinja request and response body transforms, travelling with the header ones.',
    kind: 'configured',
    scope: 'per-version',
    fields: ['transform_body'],
  },
  {
    position: 17,
    id: 'mock',
    layer: 'MockResponseLayer',
    title: 'Mock responses',
    summary:
      'Answers matching requests without the upstream. Below auth, so mocks on a protected API stay protected; responses still get transforms.',
    kind: 'configured',
    scope: 'per-version',
    fields: ['mock_responses'],
  },
  {
    position: 18,
    id: 'cache',
    layer: 'CacheLayer',
    title: 'Response cache',
    summary:
      'Caches safe requests. Hits still need credentials and consume rate; the stored copy is the raw upstream response, and mocks are never cached.',
    kind: 'configured',
    scope: 'per-version',
    fields: ['cache'],
  },
  {
    position: 19,
    id: 'api-id-header',
    layer: 'ApiIdHeaderLayer',
    title: 'x-g2-api-id header',
    summary: 'Sets x-g2-api-id on the upstream-bound request. Innermost, so nothing can spoof it.',
    kind: 'always',
    scope: 'per-version',
    fields: [],
  },
];

/** The id of the node after slot 19: the forwarder, which is not a slot. */
export const FORWARDER_ID = 'forwarder';

/**
 * The DOM id for a slot (or the forwarder) in the Chain tab. A versioned API
 * has one inner chain per version, so per-version slots take the version name.
 */
export function chainAnchor(slotId: string, version?: string): string {
  return version === undefined
    ? `chain-${slotId}`
    : `chain-v-${encodeURIComponent(version)}-${slotId}`;
}

/**
 * The slots (and the forwarder) the designer's Form tab has an editor section
 * for. Linking runs one way, chain to editor: the Chain tab gives each of
 * these an "Edit" link to `#editorAnchor(id)`, and the form's section for it
 * carries that id (`<Section id={editorAnchor(id)}>`). Adding an editor means
 * adding its slot id here and that `id` to its section; `api-designer.tsx`
 * switches tabs and scrolls for any `#edit-…` link.
 */
export const EDITOR_SLOTS: readonly string[] = [
  'ip-filter',
  'cors',
  'path-policy',
  'size-limit',
  'auth',
  'rate-limit',
  'transform-headers',
  'transform-body',
  'mock',
  FORWARDER_ID,
];

/** The DOM id of the form section editing a slot (see {@link EDITOR_SLOTS}). */
export function editorAnchor(slotId: string): string {
  return `edit-${slotId}`;
}

/**
 * - `on`: the definition configures it (or it is always present).
 * - `off`: absent from this chain.
 * - `gateway`: depends on gateway flags the dashboard cannot see.
 * - `unreached`: present, but a GraphQL executor above answers first.
 */
export type SlotState = 'on' | 'off' | 'gateway' | 'unreached';

export type SlotStatus = {
  slot: ChainSlot;
  state: SlotState;
  /** Why, in terms of the definition's fields. */
  reason: string;
};

/** The forwarder: what happens to requests that reach past slot 19. */
export type ForwarderStatus = {
  /** Where requests go, or null when a GraphQL executor forwards nothing. */
  target: string | null;
  /** Forwarder-level settings in effect (URL rewrites, method override). */
  notes: string[];
};

export type VersionChain = {
  name: string;
  isDefault: boolean;
  /** `expires_at`, unix seconds, when set. */
  expiresAt: number | null;
  /** Fields this version replaces, in `VersionOverrides` order. */
  overrides: string[];
  /** Slots 8–19. */
  inner: SlotStatus[];
  forwarder: ForwarderStatus;
};

export type Chain =
  | { versioned: false; slots: SlotStatus[]; forwarder: ForwarderStatus }
  | {
      versioned: true;
      /** Slots 1–7, around the version dispatcher. */
      outer: SlotStatus[];
      /** Where the dispatcher reads the version from. */
      selector: { location: string; key: string; defaultVersion: string | null };
      versions: VersionChain[];
    };

const nonEmpty = (list: readonly unknown[] | null | undefined): boolean =>
  list !== undefined && list !== null && list.length > 0;

/** GraphQL execution modes where the gateway executes and forwards nothing. */
const EXECUTING_MODES = new Set(['udg', 'supergraph']);

function graphqlExecutes(def: ApiDefinition): string | null {
  const g = def.graphql;
  if (g === undefined || g === null || g.enabled === false) return null;
  const mode = g.execution_mode ?? 'proxy';
  return EXECUTING_MODES.has(mode) ? mode : null;
}

function status(def: ApiDefinition, slot: ChainSlot): SlotStatus {
  const on = (reason: string): SlotStatus => ({ slot, state: 'on', reason });
  const off = (reason: string): SlotStatus => ({ slot, state: 'off', reason });
  if (slot.kind === 'gateway') {
    return { slot, state: 'gateway', reason: 'Set by gateway flags, not by the definition.' };
  }
  if (slot.kind === 'always') return on('Always present.');

  const keyless = def.auth?.mode === 'keyless';
  switch (slot.id) {
    case 'ip-filter':
      return nonEmpty(def.allow_ips) || nonEmpty(def.block_ips)
        ? on('allow_ips or block_ips is set.')
        : off('No allow_ips or block_ips.');
    case 'cors':
      return def.cors ? on('cors is set.') : off('No cors.');
    case 'path-policy':
      return nonEmpty(def.allow_paths) ||
        nonEmpty(def.block_paths) ||
        nonEmpty(def.ignore_auth_paths)
        ? on('allow_paths, block_paths or ignore_auth_paths is set.')
        : off('No path rules.');
    case 'size-limit':
      return def.max_request_body_bytes !== undefined && def.max_request_body_bytes !== null
        ? on(`Limit: ${def.max_request_body_bytes} bytes.`)
        : off('No max_request_body_bytes.');
    case 'plugins-pre':
      return nonEmpty(def.plugins?.pre) ? on('plugins.pre is set.') : off('No plugins.pre.');
    case 'auth':
      return keyless
        ? off('Keyless API.')
        : on(def.auth ? `Mode: ${def.auth.mode}.` : 'Mode: auth_token (auth is absent).');
    case 'rate-limit':
      if (!keyless) return on('Session rate and quota apply to every authenticated API.');
      return nonEmpty(def.endpoint_rate_limits)
        ? on('Keyless, but endpoint_rate_limits is set.')
        : off('Keyless, with no endpoint_rate_limits.');
    case 'plugins-post':
      return nonEmpty(def.plugins?.post) ? on('plugins.post is set.') : off('No plugins.post.');
    case 'graphql':
      if (!def.graphql) return off('No graphql.');
      if (def.graphql.enabled === false) return off('graphql.enabled is false.');
      return on(`Mode: ${def.graphql.execution_mode ?? 'proxy'}.`);
    case 'transform-headers':
      return def.transform_headers ? on('transform_headers is set.') : off('No transform_headers.');
    case 'transform-body':
      return def.transform_body ? on('transform_body is set.') : off('No transform_body.');
    case 'mock':
      return nonEmpty(def.mock_responses)
        ? on('mock_responses is set.')
        : off('No mock_responses.');
    case 'cache':
      return def.cache ? on('cache is set.') : off('No cache.');
    default:
      throw new Error(`chain.ts: no rule for slot ${slot.id}`);
  }
}

/** Statuses for the given slots, marking those a GraphQL executor never reaches. */
function statuses(def: ApiDefinition, slots: readonly ChainSlot[]): SlotStatus[] {
  const executes = graphqlExecutes(def);
  const graphqlAt = CHAIN_SLOTS.find((s) => s.id === 'graphql')?.position ?? 0;
  return slots.map((slot) => {
    const s = status(def, slot);
    if (executes !== null && slot.position > graphqlAt && s.state === 'on') {
      return {
        slot,
        state: 'unreached',
        reason: `${s.reason} Never reached: in ${executes} mode GraphQL answers every request itself.`,
      };
    }
    return s;
  });
}

function forwarder(def: ApiDefinition): ForwarderStatus {
  const executes = graphqlExecutes(def);
  if (executes !== null) {
    return {
      target: null,
      notes: [`Nothing is forwarded in ${executes} mode; target_url is required but unused.`],
    };
  }
  const notes: string[] = [];
  if (nonEmpty(def.url_rewrites)) {
    notes.push(`${def.url_rewrites?.length} URL rewrite rule(s) decide the upstream path.`);
  }
  if (def.transform_method) notes.push(`Method sent upstream: ${def.transform_method}.`);
  const target = nonEmpty(def.target_list)
    ? `${def.target_list?.length} targets, round-robin`
    : def.target_url;
  return { target, notes };
}

/**
 * A version's effective definition: the base with every present override
 * replacing its field wholesale, as `VersioningConfig::apply` does. `null`
 * and absent both inherit.
 */
export function applyVersion(base: ApiDefinition, overrides: VersionOverrides): ApiDefinition {
  const def: ApiDefinition = { ...base, versioning: null };
  const set = def as Record<string, unknown>;
  for (const [field, value] of Object.entries(overrides)) {
    if (field === 'expires_at' || value === undefined || value === null) continue;
    set[field] = value;
  }
  return def;
}

const OUTER = CHAIN_SLOTS.filter((s) => s.scope === 'shared');
const INNER = CHAIN_SLOTS.filter((s) => s.scope === 'per-version');

/** The chain g2way builds for `def`, as `build` or `build_outer`/`build_inner` would. */
export function chainFor(def: ApiDefinition): Chain {
  const versioning: VersioningConfig | null | undefined = def.versioning;
  if (!versioning) {
    return { versioned: false, slots: statuses(def, CHAIN_SLOTS), forwarder: forwarder(def) };
  }
  const defaultVersion = versioning.default_version ?? null;
  return {
    versioned: true,
    outer: statuses(def, OUTER),
    selector: {
      location: versioning.location ?? 'header',
      key: versioning.key ?? 'x-api-version',
      defaultVersion,
    },
    versions: Object.entries(versioning.versions).map(([name, overrides]) => {
      const effective = applyVersion(def, overrides);
      return {
        name,
        isDefault: name === defaultVersion,
        expiresAt: overrides.expires_at ?? null,
        overrides: Object.entries(overrides)
          .filter(
            ([field, value]) => field !== 'expires_at' && value !== undefined && value !== null,
          )
          .map(([field]) => field),
        inner: statuses(effective, INNER),
        forwarder: forwarder(effective),
      };
    }),
  };
}
