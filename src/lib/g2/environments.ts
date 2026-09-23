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
  ) {
    this.#secret = secret;
  }

  /** The admin secret. Kept off the instance's own properties so it never serialises. */
  get secret(): string {
    return this.#secret;
  }

  toJSON(): Omit<GatewayTarget, 'secret' | 'toJSON'> {
    return {
      id: this.id,
      label: this.label,
      baseUrl: this.baseUrl,
      orgId: this.orgId,
      proxyUrl: this.proxyUrl,
    };
  }
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
    environments.push(
      new GatewayTarget(SINGLE_ID, SINGLE_LABEL, baseUrl, secret ?? '', orgId, proxyUrl),
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
      environments.push(new GatewayTarget(id, label, baseUrl, secret ?? '', orgId, proxyUrl));
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
