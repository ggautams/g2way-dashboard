import 'server-only';

/**
 * The environment registry: the named g2way gateways this dashboard can talk to.
 *
 * Each environment is an admin base URL plus the shared admin secret the gateway
 * checks in `X-G2-Authorization`. That secret controls the whole gateway, so this
 * module is server-only: the only shape allowed to reach a client component is
 * {@link PublicEnvironment}, which carries neither the URL nor the secret.
 *
 * An environment may also name its **proxy** (data-plane) base URL, which only
 * the request console uses (ADR-0011). It has no default: the console sends
 * real traffic to real upstreams, so it stays off until someone points it at
 * the right listener.
 *
 * An environment may name the **Redis** its gateway stores into, from which the
 * analytics ingest worker drains the record list (ADR-0012). That URL can carry
 * a password, so it is held like the secret: never serialised, never echoed.
 *
 * An environment may name a **Prometheus** that scrapes its gateway, for
 * long-range traffic charts (ADR-0015). Its URL and token are held the same way.
 *
 * Configuration comes from the process environment — see `.env.example`.
 */

/** g2way's `DEFAULT_ORG_ID`; the fallback when `G2_ORG_ID` is unset. */
const FALLBACK_ORG_ID = 'default';

/** Where `G2_ADMIN_LISTEN` points in g2way's own examples. */
const FALLBACK_ADMIN_URL = 'http://127.0.0.1:9696';

/** Id and label of the environment built from `G2_ADMIN_URL` / `G2_ADMIN_SECRET`. */
const SINGLE_ID = 'gateway';
const SINGLE_LABEL = 'Gateway';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** One gateway, as the BFF needs it. Server-side only. */
export class GatewayTarget {
  readonly #secret: string;

  constructor(
    readonly id: string,
    readonly label: string,
    /** Admin API base URL, without a trailing slash. */
    readonly baseUrl: string,
    secret: string,
    readonly orgId: string,
    /**
     * The proxy listener's base URL (g2way's `G2_LISTEN`), without a trailing
     * slash; `null` when not configured. Only the request console sends to it.
     */
    readonly proxyUrl: string | null = null,
    /**
     * The gateway's Redis (g2way's `G2_REDIS_URL`), for the analytics ingest
     * worker only; `null` when not configured.
     */
    redisUrl: string | null = null,
    /**
     * A Prometheus that scrapes this gateway's `/metrics`, for long-range
     * traffic charts (ADR-0015); `null` when not configured.
     */
    prometheus: PrometheusSource | null = null,
  ) {
    this.#secret = secret;
    this.#redisUrl = redisUrl;
    this.#prometheus = prometheus;
  }

  readonly #redisUrl: string | null;
  readonly #prometheus: PrometheusSource | null;

  /** The Prometheus datasource, whose URL and credentials stay server-side. */
  get prometheus(): PrometheusSource | null {
    return this.#prometheus;
  }

  /** The Redis URL, which may carry a password. Kept off the own properties, like the secret. */
  get redisUrl(): string | null {
    return this.#redisUrl;
  }

  /** The admin secret. Kept off the instance's own properties so it never serialises. */
  get secret(): string {
    return this.#secret;
  }

  toJSON(): Omit<GatewayTarget, 'secret' | 'redisUrl' | 'prometheus' | 'toJSON'> {
    return {
      id: this.id,
      label: this.label,
      baseUrl: this.baseUrl,
      orgId: this.orgId,
      proxyUrl: this.proxyUrl,
    };
  }
}

/**
 * A Prometheus HTTP API that scrapes one environment's gateway (ADR-0015).
 * The URL may have held a password and the token is one, so both are kept
 * in private fields: nothing here serialises except the selector.
 */
export class PrometheusSource {
  readonly #baseUrl: string;
  readonly #authorization: string | null;
  readonly #secrets: readonly string[];

  constructor(
    /** The API base URL, without userinfo or a trailing slash. */
    baseUrl: string,
    /** The `Authorization` header value, or `null` to send none. */
    authorization: string | null,
    /**
     * Extra label matchers (`G2_PROMETHEUS_SELECTOR`), such as
     * `job="g2way-prod"`, without braces; `null` for none.
     */
    readonly selector: string | null,
    /** Credential strings every message is scrubbed of before it is shown. */
    secrets: readonly string[] = [],
  ) {
    this.#baseUrl = baseUrl;
    this.#authorization = authorization;
    this.#secrets = secrets.filter((secret) => secret !== '');
  }

  /** Where the Prometheus HTTP API lives. Server-side only. */
  get baseUrl(): string {
    return this.#baseUrl;
  }

  get authorization(): string | null {
    return this.#authorization;
  }

  /** `message` with the URL and every credential replaced, so it is safe to show. */
  scrub(message: string): string {
    let out = message;
    for (const secret of [this.#baseUrl, ...this.#secrets]) {
      if (secret !== '') out = out.split(secret).join('[redacted]');
    }
    return out;
  }

  toJSON(): { selector: string | null } {
    return { selector: this.selector };
  }
}

/** One PromQL label matcher: `name op "value"`, the value a Go-style quoted string. */
const MATCHER = /\s*[A-Za-z_][A-Za-z0-9_]*\s*(?:=~|!~|!=|=)\s*"(?:[^"\\\n]|\\.)*"\s*/y;

/** `raw` as matchers to splice into a selector, or `null` when it is not a matcher list. */
export function parseSelector(raw: string): string | null {
  let body = raw.trim();
  if (body.startsWith('{') && body.endsWith('}')) body = body.slice(1, -1).trim();
  if (body === '') return null;
  const matchers: string[] = [];
  let at = 0;
  while (at < body.length) {
    MATCHER.lastIndex = at;
    const match = MATCHER.exec(body);
    if (match === null) return null;
    matchers.push(match[0].trim());
    at = MATCHER.lastIndex;
    if (at < body.length) {
      if (body[at] !== ',') return null;
      at += 1;
    }
  }
  return matchers.join(',');
}

/**
 * The environment's Prometheus source from `<prefix>_PROMETHEUS_URL`, `_TOKEN`
 * and `_SELECTOR`, or `null` when no URL is set. Problems name the variable,
 * never its value: the URL may hold a password.
 */
function optionalPrometheus(env: Env, prefix: string, problems: string[]): PrometheusSource | null {
  const urlVar = `${prefix}PROMETHEUS_URL`;
  const tokenVar = `${prefix}PROMETHEUS_TOKEN`;
  const selectorVar = `${prefix}PROMETHEUS_SELECTOR`;
  const raw = read(env, urlVar);
  const token = read(env, tokenVar);
  const rawSelector = read(env, selectorVar);
  if (raw === undefined) {
    for (const [name, value] of [
      [tokenVar, token],
      [selectorVar, rawSelector],
    ] as const) {
      if (value !== undefined) problems.push(`${name} is set but ${urlVar} is not`);
    }
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`${urlVar} is not a valid URL`);
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    problems.push(`${urlVar} must be an http:// or https:// URL`);
    return null;
  }
  const secrets: string[] = [];
  let authorization: string | null = null;
  if (url.username !== '' || url.password !== '') {
    let user: string;
    let password: string;
    try {
      user = decodeURIComponent(url.username);
      password = decodeURIComponent(url.password);
    } catch {
      problems.push(`${urlVar} has credentials that are not valid percent-encoding`);
      return null;
    }
    secrets.push(url.password, password);
    authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
    if (token !== undefined) {
      problems.push(`${urlVar} carries credentials and ${tokenVar} is set; use one or the other`);
      return null;
    }
    url.username = '';
    url.password = '';
  }
  if (token !== undefined) {
    secrets.push(token);
    authorization = `Bearer ${token}`;
  }
  if (url.search !== '' || url.hash !== '') {
    problems.push(`${urlVar} must not carry a query string or fragment`);
    return null;
  }
  let selector: string | null = null;
  if (rawSelector !== undefined) {
    selector = parseSelector(rawSelector);
    if (selector === null) {
      problems.push(`${selectorVar} must be PromQL label matchers, such as job="g2way"`);
      return null;
    }
  }
  const baseUrl = url.toString().replace(/\/+$/, '');
  return new PrometheusSource(baseUrl, authorization, selector, secrets);
}

/** What a client component may know about an environment. */
export type PublicEnvironment = {
  id: string;
  label: string;
  isDefault: boolean;
};

export type Registry = {
  orgId: string;
  defaultId: string;
  environments: readonly GatewayTarget[];
};

/** The environment configuration is unusable; `problems` names each offending variable. */
export class RegistryConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`gateway environment configuration is invalid:\n  - ${problems.join('\n  - ')}`);
    this.name = 'RegistryConfigError';
  }
}

export class UnknownEnvironmentError extends Error {
  constructor(readonly environmentId: string) {
    super(`unknown gateway environment: ${environmentId}`);
    this.name = 'UnknownEnvironmentError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function read(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function normaliseUrl(raw: string, variable: string, problems: string[]): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`${variable} is not a valid URL`);
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    problems.push(`${variable} must be an http:// or https:// URL`);
    return '';
  }
  return url.toString().replace(/\/+$/, '');
}

/** An optional URL variable: `null` when unset, `''` (with a problem) when invalid. */
function optionalUrl(env: Env, variable: string, problems: string[]): string | null {
  const raw = read(env, variable);
  return raw === undefined ? null : normaliseUrl(raw, variable, problems);
}

/**
 * An optional Redis URL variable: `null` when unset, `''` (with a problem) when
 * invalid. The problem names the variable only: the value may hold a password.
 */
function optionalRedisUrl(env: Env, variable: string, problems: string[]): string | null {
  const raw = read(env, variable);
  if (raw === undefined) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`${variable} is not a valid URL`);
    return '';
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    problems.push(`${variable} must be a redis:// or rediss:// URL`);
    return '';
  }
  return raw;
}

/** Prefix of the per-environment variables for `id`: `staging-eu` → `G2_ENV_STAGING_EU`. */
export function envPrefix(id: string): string {
  return `G2_ENV_${id.toUpperCase().replace(/-/g, '_')}`;
}

/**
 * Builds the registry from environment variables. Pure, so it is tested directly;
 * reports every problem at once rather than the first, and never echoes a secret.
 */
export function parseEnvironments(env: Env): Registry {
  const problems: string[] = [];
  const orgId = parseOrgId(env);
  const environments: GatewayTarget[] = [];

  const list = read(env, 'G2_ENVIRONMENTS');
  if (list === undefined) {
    const baseUrl = normaliseUrl(
      read(env, 'G2_ADMIN_URL') ?? FALLBACK_ADMIN_URL,
      'G2_ADMIN_URL',
      problems,
    );
    const secret = read(env, 'G2_ADMIN_SECRET');
    if (secret === undefined) problems.push('G2_ADMIN_SECRET is not set');
    const proxyUrl = optionalUrl(env, 'G2_PROXY_URL', problems);
    const redisUrl = optionalRedisUrl(env, 'G2_REDIS_URL', problems);
    const prometheus = optionalPrometheus(env, 'G2_', problems);
    environments.push(
      new GatewayTarget(
        SINGLE_ID,
        SINGLE_LABEL,
        baseUrl,
        secret ?? '',
        orgId,
        proxyUrl,
        redisUrl,
        prometheus,
      ),
    );
  } else {
    const ids = list
      .split(',')
      .map((id) => id.trim().toLowerCase())
      .filter((id) => id !== '');
    if (ids.length === 0) problems.push('G2_ENVIRONMENTS lists no environment ids');
    const seen = new Set<string>();
    for (const id of ids) {
      if (!ID_PATTERN.test(id)) {
        problems.push(`G2_ENVIRONMENTS: "${id}" is not a valid id (use a-z, 0-9 and -)`);
        continue;
      }
      if (seen.has(id)) {
        problems.push(`G2_ENVIRONMENTS lists "${id}" more than once`);
        continue;
      }
      seen.add(id);
      const prefix = envPrefix(id);
      const rawUrl = read(env, `${prefix}_URL`);
      const secret = read(env, `${prefix}_SECRET`);
      if (rawUrl === undefined) problems.push(`${prefix}_URL is not set`);
      if (secret === undefined) problems.push(`${prefix}_SECRET is not set`);
      const baseUrl = rawUrl === undefined ? '' : normaliseUrl(rawUrl, `${prefix}_URL`, problems);
      const label = read(env, `${prefix}_LABEL`) ?? id;
      const proxyUrl = optionalUrl(env, `${prefix}_PROXY_URL`, problems);
      const redisUrl = optionalRedisUrl(env, `${prefix}_REDIS_URL`, problems);
      const prometheus = optionalPrometheus(env, `${prefix}_`, problems);
      environments.push(
        new GatewayTarget(id, label, baseUrl, secret ?? '', orgId, proxyUrl, redisUrl, prometheus),
      );
    }
  }

  const requestedDefault = read(env, 'G2_DEFAULT_ENVIRONMENT')?.toLowerCase();
  if (
    requestedDefault !== undefined &&
    !environments.some((target) => target.id === requestedDefault)
  ) {
    problems.push(`G2_DEFAULT_ENVIRONMENT "${requestedDefault}" is not a configured environment`);
  }

  if (problems.length > 0) throw new RegistryConfigError(problems);
  return { orgId, defaultId: requestedDefault ?? environments[0].id, environments };
}

let cached: Registry | undefined;

/** The registry for this process, parsed once from `process.env`. */
export function getRegistry(): Registry {
  cached ??= parseEnvironments(process.env);
  return cached;
}

/** `G2_ORG_ID`, or g2way's default org when unset. */
export function parseOrgId(env: Env): string {
  return read(env, 'G2_ORG_ID') ?? FALLBACK_ORG_ID;
}

/**
 * The org every gateway request and dashboard record is made on behalf of
 * (`G2_ORG_ID`). Independent of the rest of the registry, so signing in still
 * works while the gateway configuration is broken — the Overview is where that
 * gets reported.
 */
export function getOrgId(): string {
  return parseOrgId(process.env);
}

/** The environment to call, or the default one when `id` is omitted. */
export function resolveEnvironment(id?: string, registry: Registry = getRegistry()): GatewayTarget {
  const wanted = id ?? registry.defaultId;
  const target = registry.environments.find((candidate) => candidate.id === wanted);
  if (target === undefined) throw new UnknownEnvironmentError(wanted);
  return target;
}

/** The environments, reduced to what is safe to hand to the browser. */
export function listEnvironments(registry: Registry = getRegistry()): PublicEnvironment[] {
  return registry.environments.map(({ id, label }) => ({
    id,
    label,
    isDefault: id === registry.defaultId,
  }));
}
