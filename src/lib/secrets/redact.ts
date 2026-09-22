import { can, type Permission, type Role } from '@/lib/auth/rbac';
import type { JsonValue } from '@/lib/db/schema/shared';
import type { components } from '../../../contracts/g2way.d.ts';
import { looksLikeUrl, maskUrlCredentials } from './url';

/**
 * Secret visibility for read-only roles (ADR-0010). Universal and
 * dependency-free: the BFF proxy, the page loaders and the history seam all
 * call {@link redactFor}; the proxy calls {@link findMasked} to refuse a write
 * that would store the mask.
 *
 * A role that cannot write a kind cannot see its secrets: without
 * `apis:write` an API definition's secrets are masked, without
 * `policies:write` a policy's, without `keys:write` a key session's. The
 * gateway still stores and serves everything; this is presentation, enforced
 * server-side before a body reaches the browser.
 */

type Schemas = components['schemas'];

export type SecretKind = 'api' | 'policy' | 'key';

/** The body type each kind's paths are checked against. */
type Bodies = {
  api: Schemas['ApiDefinition'];
  policy: Schemas['Policy'];
  key: Schemas['KeySession'];
};

/** The fixed value a hidden secret reads as. The write guard refuses any body carrying it. */
export const SECRET_MASK = '[secret hidden]';

/** Holding this permission for a kind reveals that kind's secrets. */
export const REVEAL_PERMISSION: Readonly<Record<SecretKind, Permission>> = {
  api: 'apis:write',
  policy: 'policies:write',
  key: 'keys:write',
};

// ---- typed paths --------------------------------------------------------------

type Prev = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** Walks one (non-null) type; a naked parameter, so unions such as `AuthConfig` distribute. */
type Walk<T, D extends number> = [D] extends [never]
  ? never
  : T extends readonly (infer E)[]
    ? '[]' | `[].${SecretPath<E, Prev[D]>}`
    : T extends object
      ? string extends keyof T
        ? '*' | `*.${SecretPath<T[string & keyof T], Prev[D]>}`
        : { [K in keyof T & string]-?: K | `${K}.${SecretPath<T[K], Prev[D]>}` }[keyof T & string]
      : never;

/**
 * Every dotted path into `T`: property names, `*` for any key of a map, `[]`
 * for every element of an array. A path the contract does not have is a type
 * error, so a `sync:g2way` that moves a secret field turns `tsc` red here.
 */
export type SecretPath<T, D extends number = 10> = Walk<NonNullable<T>, D>;

/** Paths below `versioning.versions.*` repeat the top-level override-able fields. */
const OVERRIDABLE = [
  'transform_headers.request.add.*',
  'graphql.schema_sync.headers.*',
  'graphql.data_sources.*.headers.*',
  'graphql.supergraph.subgraphs.[].headers.*',
] as const satisfies readonly SecretPath<Schemas['VersionOverrides']>[];

/**
 * The secret-bearing fields of each kind, from `contracts/g2way.d.ts` and the
 * vendored docs (ADR-0010 has the reasoning per field). A header map is listed
 * whole where its headers go upstream: a path cannot tell an `Authorization`
 * from an `X-Trace`, and the docs name these maps as the place for upstream
 * credentials (`graphql.md`: schema sync, UDG, subgraphs).
 */
export const SECRET_PATHS: {
  readonly [K in SecretKind]: readonly SecretPath<Bodies[K]>[];
} = {
  api: [
    // JWT HS256 shared secret (`auth.mode = "jwt"`).
    'auth.secret',
    ...OVERRIDABLE,
    ...OVERRIDABLE.map((path) => `versioning.versions.*.${path}` as const),
  ],
  // Policies carry access, rate and quota only: nothing secret in the contract today.
  policy: [],
  key: [
    // HMAC shared secret, stored in plaintext (vendored `hmac.md`).
    'hmac.secret',
    // bcrypt hash of the basic-auth password: not the password, but crackable offline.
    'basic_auth.password_hash',
  ],
};

/**
 * Belt and braces: a string or number under a property name like these is
 * masked anywhere in the body, for fields the contract does not type (plugin
 * `config`, UDG `variables`) and fields a future `sync:g2way` adds before the
 * path list catches up. Deliberately narrower than the audit redactor's
 * name rule (ADR-0006 §4): a viewer still sees `auth.cookie`, `auth.header`
 * and `public_key_pem`, which configure where a credential goes, not what it is.
 */
export const SECRET_NAME =
  /secret|passw|private[-_]?key|credential|api[-_]?key|authorization|(?:^|[-_])token$/i;

// ---- URLs ------------------------------------------------------------------------

/**
 * Upstream URLs, top level and per version: their userinfo and credential
 * query parameters are masked, the rest stays readable ({@link maskUrlCredentials}).
 * `target_list` and `service_discovery.endpoint` follow `target_url`'s rules
 * upstream, so they are listed with it.
 */
const OVERRIDABLE_URLS = [
  'target_url',
  'target_list.[]',
  'service_discovery.endpoint',
  'graphql.schema_sync.url',
  'graphql.data_sources.*.url',
  'graphql.supergraph.subgraphs.[].url',
] as const satisfies readonly SecretPath<Schemas['VersionOverrides']>[];

/** The URL-valued fields of each kind whose embedded credentials are masked (ADR-0010 §3). */
export const SECRET_URL_PATHS: {
  readonly [K in SecretKind]: readonly SecretPath<Bodies[K]>[];
} = {
  api: [
    ...OVERRIDABLE_URLS,
    ...OVERRIDABLE_URLS.map((path) => `versioning.versions.*.${path}` as const),
  ],
  policy: [],
  key: [],
};

/**
 * {@link SECRET_MASK} as it appears inside a masked URL: percent-encoded, so
 * the URL still parses (`https://%5Bsecret%20hidden%5D@host/?api_key=%5Bsecret%20hidden%5D`).
 */
export const SECRET_URL_MASK = encodeURIComponent(SECRET_MASK);

/** The URL form of the mask, however it was re-encoded (`%5b`, `+` for the space). */
const URL_MASK_PATTERN = /%5bsecret(?:%20|\+)hidden%5d/i;

/** Whether `text` carries the mask, whole, inside a string, or inside a URL. */
export function containsMask(text: string): boolean {
  return text.includes(SECRET_MASK) || URL_MASK_PATTERN.test(text);
}

// ---- the walk ------------------------------------------------------------------

export const SECRET_KINDS: readonly SecretKind[] = ['api', 'policy', 'key'];

/** Where a value sits: its property name, and whether a typed path ends on it. */
export type SecretSite = {
  /** The property holding the value; `null` for an array element or the root. */
  name: string | null;
  /** A {@link SECRET_PATHS} entry ends here. */
  secretPath: boolean;
  /** A {@link SECRET_URL_PATHS} entry ends here. */
  urlPath: boolean;
};

type Segments = readonly (readonly string[])[];

function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function advance(paths: Segments, segment: string, wildcard: string | null): Segments {
  return paths
    .filter((path) => path[0] === segment || (wildcard !== null && path[0] === wildcard))
    .map((path) => path.slice(1));
}

/**
 * A copy of `value` where `replace` decides each node, top down: a result
 * other than `undefined` stands in for the node, `undefined` walks into it.
 * `counterpart` is the node at the same place in `compareTo` (the audit
 * redactor's other snapshot). Shared by {@link redactSecrets} and the audit
 * redactor (ADR-0006 §4), so both follow the same typed path lists.
 */
export function mapSecrets(
  kinds: readonly SecretKind[],
  value: JsonValue,
  compareTo: JsonValue | null | undefined,
  replace: (
    value: JsonValue,
    counterpart: JsonValue | undefined,
    site: SecretSite,
  ) => JsonValue | undefined,
): JsonValue {
  const split = (lists: typeof SECRET_PATHS | typeof SECRET_URL_PATHS): Segments =>
    kinds.flatMap((kind) => lists[kind].map((path) => path.split('.')));
  const walk = (
    node: JsonValue,
    other: JsonValue | undefined,
    name: string | null,
    secrets: Segments,
    urls: Segments,
  ): JsonValue => {
    const site = {
      name,
      secretPath: secrets.some((path) => path.length === 0),
      urlPath: urls.some((path) => path.length === 0),
    };
    const replaced = replace(node, other, site);
    if (replaced !== undefined) return replaced;
    if (Array.isArray(node)) {
      return node.map((item, i) =>
        walk(
          item,
          Array.isArray(other) ? other[i] : undefined,
          null,
          advance(secrets, '[]', null),
          advance(urls, '[]', null),
        ),
      );
    }
    if (!isRecord(node)) return node;
    return Object.fromEntries(
      Object.entries(node).map(([key, child]) => [
        key,
        walk(
          child,
          isRecord(other) && Object.hasOwn(other, key) ? other[key] : undefined,
          key,
          advance(secrets, key, '*'),
          advance(urls, key, '*'),
        ),
      ]),
    );
  };
  return walk(value, compareTo ?? undefined, null, split(SECRET_PATHS), split(SECRET_URL_PATHS));
}

// ---- redaction -----------------------------------------------------------------

function isSecretValue(value: JsonValue | undefined): value is string | number {
  return typeof value === 'string' || typeof value === 'number';
}

/**
 * `body` (one `kind` record) with every present secret replaced by
 * {@link SECRET_MASK}, and every credential inside a URL by
 * {@link SECRET_URL_MASK}. Pure: `body` is not modified. The shape is kept: no
 * field is added or removed, `null` and absent stay so, and booleans are never
 * touched. Anything that is not an object comes back as it is.
 *
 * URLs: the typed {@link SECRET_URL_PATHS}, plus, like the name fallback, any
 * string anywhere that reads as `scheme://…` (a plugin config's URL). Only the
 * credential parts change, so this never hides a host or a path.
 */
export function redactSecrets<T>(kind: SecretKind, body: T): T {
  // Gateway bodies are parsed JSON; the contract types are narrower views of it.
  const json = body as JsonValue;
  if (!isRecord(json)) return body;
  return mapSecrets([kind], json, undefined, (value, _counterpart, site) => {
    if (
      isSecretValue(value) &&
      (site.secretPath || (site.name !== null && SECRET_NAME.test(site.name)))
    ) {
      return SECRET_MASK;
    }
    if (typeof value === 'string' && (site.urlPath || looksLikeUrl(value))) {
      return maskUrlCredentials(value, SECRET_URL_MASK);
    }
    return undefined;
  }) as T;
}

/** Whether `role` sees `kind`'s secrets: it holds the kind's write permission. */
export function mayReveal(role: Role, kind: SecretKind): boolean {
  return can(role, REVEAL_PERMISSION[kind]);
}

/** `body` as `role` may see it: unchanged for a writer, {@link redactSecrets} otherwise. */
export function redactFor<T>(role: Role, kind: SecretKind, body: T): T {
  return mayReveal(role, kind) ? body : redactSecrets(kind, body);
}

/** {@link redactFor} over a gateway list, or one record. */
export function redactEachFor<T>(role: Role, kind: SecretKind, body: T): T {
  if (mayReveal(role, kind)) return body;
  if (!Array.isArray(body)) return redactSecrets(kind, body);
  return body.map((item: unknown) => redactSecrets(kind, item)) as T;
}

/**
 * The dotted paths in `body` whose value carries {@link SECRET_MASK}, whole or
 * inside a masked URL ({@link containsMask}): a body read
 * by a role that could not see its secrets. Writing it back would replace real
 * secrets with the mask, so the BFF refuses it (ADR-0010).
 */
export function findMasked(body: JsonValue, at = ''): string[] {
  if (typeof body === 'string' && containsMask(body)) return [at === '' ? '(the body)' : at];
  const join = (key: string | number) => (at === '' ? String(key) : `${at}.${key}`);
  if (Array.isArray(body)) return body.flatMap((item, i) => findMasked(item, join(i)));
  if (isRecord(body)) {
    return Object.entries(body).flatMap(([key, value]) => findMasked(value, join(key)));
  }
  return [];
}
