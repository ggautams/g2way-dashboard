import { describe, expect, it } from 'vitest';
import { inspect } from 'node:util';
import {
  RegistryConfigError,
  UnknownEnvironmentError,
  envPrefix,
  listEnvironments,
  parseEnvironments,
  parseOrgId,
  parseSelector,
  resolveEnvironment,
} from './environments';

const SECRET = 'test-secret-do-not-leak';

function problemsOf(env: Record<string, string>): readonly string[] {
  try {
    parseEnvironments(env);
  } catch (error) {
    if (error instanceof RegistryConfigError) return error.problems;
    throw error;
  }
  throw new Error('expected parseEnvironments to reject the configuration');
}

describe('single-gateway form', () => {
  it('defaults the URL and org, and needs only the secret', () => {
    const registry = parseEnvironments({ G2_ADMIN_SECRET: SECRET });
    const target = resolveEnvironment(undefined, registry);
    expect(target.baseUrl).toBe('http://127.0.0.1:9696');
    expect(target.secret).toBe(SECRET);
    expect(target.orgId).toBe('default');
    expect(registry.defaultId).toBe(target.id);
  });

  it('honours G2_ADMIN_URL and G2_ORG_ID, stripping trailing slashes', () => {
    const registry = parseEnvironments({
      G2_ADMIN_URL: 'https://gw.example.com/admin//',
      G2_ADMIN_SECRET: SECRET,
      G2_ORG_ID: 'acme',
    });
    const target = resolveEnvironment(undefined, registry);
    expect(target.baseUrl).toBe('https://gw.example.com/admin');
    expect(target.orgId).toBe('acme');
  });

  it('rejects a missing secret and a non-http URL together', () => {
    expect(problemsOf({ G2_ADMIN_URL: 'ftp://gw' })).toEqual([
      'G2_ADMIN_URL must be an http:// or https:// URL',
      'G2_ADMIN_SECRET is not set',
    ]);
  });

  it('treats a blank secret as missing', () => {
    expect(problemsOf({ G2_ADMIN_SECRET: '   ' })).toEqual(['G2_ADMIN_SECRET is not set']);
  });
});

describe('multi-environment form', () => {
  const env = {
    G2_ENVIRONMENTS: 'dev, Staging-EU',
    G2_ENV_DEV_URL: 'http://localhost:9696',
    G2_ENV_DEV_SECRET: 'dev-secret',
    G2_ENV_STAGING_EU_URL: 'https://staging.example.com',
    G2_ENV_STAGING_EU_SECRET: SECRET,
    G2_ENV_STAGING_EU_LABEL: 'Staging (EU)',
    // Ignored once G2_ENVIRONMENTS is set.
    G2_ADMIN_SECRET: 'unused',
  };

  it('maps ids to their variable prefix', () => {
    expect(envPrefix('staging-eu')).toBe('G2_ENV_STAGING_EU');
  });

  it('builds one target per listed id, defaulting to the first', () => {
    const registry = parseEnvironments(env);
    expect(registry.environments.map((target) => target.id)).toEqual(['dev', 'staging-eu']);
    expect(registry.defaultId).toBe('dev');
    const staging = resolveEnvironment('staging-eu', registry);
    expect(staging.label).toBe('Staging (EU)');
    expect(staging.secret).toBe(SECRET);
    expect(resolveEnvironment('dev', registry).label).toBe('dev');
  });

  it('honours G2_DEFAULT_ENVIRONMENT', () => {
    const registry = parseEnvironments({ ...env, G2_DEFAULT_ENVIRONMENT: 'staging-eu' });
    expect(resolveEnvironment(undefined, registry).id).toBe('staging-eu');
  });

  it('reports every problem at once', () => {
    expect(
      problemsOf({
        G2_ENVIRONMENTS: 'dev,dev,bad_id,prod',
        G2_ENV_DEV_URL: 'not a url',
        G2_ENV_DEV_SECRET: 'x',
        G2_DEFAULT_ENVIRONMENT: 'qa',
      }),
    ).toEqual([
      'G2_ENV_DEV_URL is not a valid URL',
      'G2_ENVIRONMENTS lists "dev" more than once',
      'G2_ENVIRONMENTS: "bad_id" is not a valid id (use a-z, 0-9 and -)',
      'G2_ENV_PROD_URL is not set',
      'G2_ENV_PROD_SECRET is not set',
      'G2_DEFAULT_ENVIRONMENT "qa" is not a configured environment',
    ]);
  });

  it('rejects a list with no ids', () => {
    expect(problemsOf({ G2_ENVIRONMENTS: ' , ' })).toContain(
      'G2_ENVIRONMENTS lists no environment ids',
    );
  });

  it('throws a typed error for an unknown id', () => {
    const registry = parseEnvironments(env);
    expect(() => resolveEnvironment('prod', registry)).toThrow(UnknownEnvironmentError);
  });
});

// The secret controls the whole gateway; these guard the ways it could slip out.
describe('secret containment', () => {
  const registry = parseEnvironments({ G2_ADMIN_SECRET: SECRET });

  it('never appears in the public view', () => {
    const view = listEnvironments(registry);
    expect(view).toEqual([{ id: 'gateway', label: 'Gateway', isDefault: true }]);
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });

  it('does not serialise or inspect out of a target', () => {
    const target = resolveEnvironment(undefined, registry);
    expect(JSON.stringify(target)).not.toContain(SECRET);
    expect(JSON.stringify(registry)).not.toContain(SECRET);
    expect(inspect(target, { depth: 5 })).not.toContain(SECRET);
    expect({ ...target }).not.toHaveProperty('secret');
  });

  it('never echoes a secret in a configuration error', () => {
    try {
      parseEnvironments({ G2_ADMIN_URL: SECRET, G2_ADMIN_SECRET: SECRET });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(SECRET);
    }
  });
});

describe('parseOrgId', () => {
  it("defaults to g2way's org and honours G2_ORG_ID", () => {
    expect(parseOrgId({})).toBe('default');
    expect(parseOrgId({ G2_ORG_ID: ' acme ' })).toBe('acme');
  });

  it('does not depend on the gateway configuration being valid', () => {
    // No G2_ADMIN_SECRET: the registry would throw, the org still resolves.
    expect(() => parseEnvironments({ G2_ORG_ID: 'acme' })).toThrow(RegistryConfigError);
    expect(parseOrgId({ G2_ORG_ID: 'acme' })).toBe('acme');
  });
});

describe('proxy URL (ADR-0011)', () => {
  it('has no default: the request console stays off until one is set', () => {
    const target = resolveEnvironment(undefined, parseEnvironments({ G2_ADMIN_SECRET: SECRET }));
    expect(target.proxyUrl).toBeNull();
  });

  it('reads G2_PROXY_URL in the single form and G2_ENV_<ID>_PROXY_URL per environment', () => {
    const single = parseEnvironments({
      G2_ADMIN_SECRET: SECRET,
      G2_PROXY_URL: 'http://127.0.0.1:8080/',
    });
    expect(resolveEnvironment(undefined, single).proxyUrl).toBe('http://127.0.0.1:8080');

    const multi = parseEnvironments({
      G2_ENVIRONMENTS: 'dev,prod',
      G2_ENV_DEV_URL: 'http://localhost:9696',
      G2_ENV_DEV_SECRET: 'dev',
      G2_ENV_DEV_PROXY_URL: 'http://localhost:8080',
      G2_ENV_PROD_URL: 'https://admin.example.com',
      G2_ENV_PROD_SECRET: 'prod',
      // The single-form variable is ignored in the multi form.
      G2_PROXY_URL: 'http://unused:8080',
    });
    expect(resolveEnvironment('dev', multi).proxyUrl).toBe('http://localhost:8080');
    expect(resolveEnvironment('prod', multi).proxyUrl).toBeNull();
  });

  it('rejects a non-http proxy URL by name', () => {
    expect(problemsOf({ G2_ADMIN_SECRET: SECRET, G2_PROXY_URL: 'gopher://gw' })).toEqual([
      'G2_PROXY_URL must be an http:// or https:// URL',
    ]);
  });

  it('never reaches the browser', () => {
    const registry = parseEnvironments({
      G2_ADMIN_SECRET: SECRET,
      G2_PROXY_URL: 'http://proxy.internal:8080',
    });
    expect(JSON.stringify(listEnvironments(registry))).not.toContain('proxy.internal');
  });
});

describe('Redis URL (ADR-0012)', () => {
  const REDIS = 'redis://:hunter2-redis@redis.internal:6379/0';

  it('is optional: an environment without one has no analytics feed', () => {
    const target = resolveEnvironment(undefined, parseEnvironments({ G2_ADMIN_SECRET: SECRET }));
    expect(target.redisUrl).toBeNull();
  });

  it('reads G2_REDIS_URL in the single form and G2_ENV_<ID>_REDIS_URL per environment', () => {
    const single = parseEnvironments({ G2_ADMIN_SECRET: SECRET, G2_REDIS_URL: REDIS });
    expect(resolveEnvironment(undefined, single).redisUrl).toBe(REDIS);

    const multi = parseEnvironments({
      G2_ENVIRONMENTS: 'dev,prod',
      G2_ENV_DEV_URL: 'http://localhost:9696',
      G2_ENV_DEV_SECRET: 'dev',
      G2_ENV_DEV_REDIS_URL: 'rediss://cache.example.com:6380',
      G2_ENV_PROD_URL: 'https://admin.example.com',
      G2_ENV_PROD_SECRET: 'prod',
      // The single-form variable is ignored in the multi form.
      G2_REDIS_URL: REDIS,
    });
    expect(resolveEnvironment('dev', multi).redisUrl).toBe('rediss://cache.example.com:6380');
    expect(resolveEnvironment('prod', multi).redisUrl).toBeNull();
  });

  it('rejects a non-redis URL by name, without echoing the value', () => {
    const problems = problemsOf({
      G2_ADMIN_SECRET: SECRET,
      G2_REDIS_URL: 'http://:hunter2-redis@redis.internal',
    });
    expect(problems).toEqual(['G2_REDIS_URL must be a redis:// or rediss:// URL']);
    expect(problemsOf({ G2_ADMIN_SECRET: SECRET, G2_REDIS_URL: 'hunter2 nope' })).toEqual([
      'G2_REDIS_URL is not a valid URL',
    ]);
  });

  it('never serialises, and never reaches the browser', () => {
    const registry = parseEnvironments({ G2_ADMIN_SECRET: SECRET, G2_REDIS_URL: REDIS });
    const target = resolveEnvironment(undefined, registry);
    expect(JSON.stringify(target)).not.toContain('hunter2');
    expect(Object.values(target).join(' ')).not.toContain('hunter2');
    expect(JSON.stringify(listEnvironments(registry))).not.toContain('hunter2');
  });
});

describe('Prometheus datasource (ADR-0015)', () => {
  const PASSWORD = 'hunter2-prom';
  const TOKEN = 'tok-hunter2-prom';
  const prometheusOf = (env: Record<string, string>, id?: string) =>
    resolveEnvironment(id, parseEnvironments({ G2_ADMIN_SECRET: SECRET, ...env })).prometheus;

  it('is off by default', () => {
    expect(prometheusOf({})).toBeNull();
  });

  it('reads G2_PROMETHEUS_* in the single form and G2_ENV_<ID>_PROMETHEUS_* per environment', () => {
    const single = prometheusOf({ G2_PROMETHEUS_URL: 'http://prom:9090/' });
    expect(single?.baseUrl).toBe('http://prom:9090');
    expect(single?.authorization).toBeNull();
    expect(single?.selector).toBeNull();

    const registry = parseEnvironments({
      G2_ENVIRONMENTS: 'dev,prod',
      G2_ENV_DEV_URL: 'http://localhost:9696',
      G2_ENV_DEV_SECRET: 'dev',
      G2_ENV_PROD_URL: 'https://admin.example.com',
      G2_ENV_PROD_SECRET: 'prod',
      G2_ENV_PROD_PROMETHEUS_URL: 'https://mimir.example.com/prometheus',
      G2_ENV_PROD_PROMETHEUS_TOKEN: TOKEN,
      G2_ENV_PROD_PROMETHEUS_SELECTOR: '{job="g2way", namespace=~"prod-.*"}',
      // The single-form variable is ignored in the multi form.
      G2_PROMETHEUS_URL: 'http://unused:9090',
    });
    expect(resolveEnvironment('dev', registry).prometheus).toBeNull();
    const prod = resolveEnvironment('prod', registry).prometheus;
    expect(prod?.baseUrl).toBe('https://mimir.example.com/prometheus');
    expect(prod?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(prod?.selector).toBe('job="g2way",namespace=~"prod-.*"');
  });

  it('turns URL credentials into Basic auth and strips them from the URL', () => {
    const source = prometheusOf({
      G2_PROMETHEUS_URL: `https://ops%40example.com:${PASSWORD}@prom.example.com`,
    });
    expect(source?.baseUrl).toBe('https://prom.example.com');
    expect(source?.authorization).toBe(
      `Basic ${Buffer.from(`ops@example.com:${PASSWORD}`).toString('base64')}`,
    );
  });

  it('reports each problem by variable name, never echoing a value', () => {
    const cases: [Record<string, string>, string][] = [
      [
        { G2_PROMETHEUS_URL: `ftp://u:${PASSWORD}@prom` },
        'G2_PROMETHEUS_URL must be an http:// or https:// URL',
      ],
      [{ G2_PROMETHEUS_URL: `${PASSWORD} nope` }, 'G2_PROMETHEUS_URL is not a valid URL'],
      [
        { G2_PROMETHEUS_URL: `http://u:${PASSWORD}@prom`, G2_PROMETHEUS_TOKEN: TOKEN },
        'G2_PROMETHEUS_URL carries credentials and G2_PROMETHEUS_TOKEN is set; use one or the other',
      ],
      [{ G2_PROMETHEUS_TOKEN: TOKEN }, 'G2_PROMETHEUS_TOKEN is set but G2_PROMETHEUS_URL is not'],
      [
        { G2_PROMETHEUS_URL: 'http://prom?x=1' },
        'G2_PROMETHEUS_URL must not carry a query string or fragment',
      ],
      [
        { G2_PROMETHEUS_URL: 'http://prom', G2_PROMETHEUS_SELECTOR: `job=${PASSWORD}` },
        'G2_PROMETHEUS_SELECTOR must be PromQL label matchers, such as job="g2way"',
      ],
    ];
    for (const [env, problem] of cases) {
      const problems = problemsOf({ G2_ADMIN_SECRET: SECRET, ...env });
      expect(problems).toEqual([problem]);
      expect(problems.join(' ')).not.toContain(PASSWORD);
      expect(problems.join(' ')).not.toContain(TOKEN);
    }
  });

  it('never serialises, inspects or lists out the URL or credentials', () => {
    const registry = parseEnvironments({
      G2_ADMIN_SECRET: SECRET,
      G2_PROMETHEUS_URL: `https://u:${PASSWORD}@prom.hidden.example`,
      G2_PROMETHEUS_SELECTOR: 'job="g2way"',
    });
    const target = resolveEnvironment(undefined, registry);
    for (const text of [
      JSON.stringify(target),
      JSON.stringify(target.prometheus),
      inspect(target, { depth: 5 }),
      inspect(target.prometheus, { depth: 5 }),
      JSON.stringify(listEnvironments(registry)),
    ]) {
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain('prom.hidden');
    }
    expect(JSON.stringify(target.prometheus)).toBe('{"selector":"job=\\"g2way\\""}');
  });
});

describe('parseSelector', () => {
  it('accepts label matchers, with or without braces', () => {
    expect(parseSelector('job="g2way"')).toBe('job="g2way"');
    // PromQL allows a trailing comma too.
    expect(parseSelector('job="a",')).toBe('job="a"');
    expect(parseSelector(' { job = "a" , env!~"dev|qa", x="q\\"uote" } ')).toBe(
      'job = "a",env!~"dev|qa",x="q\\"uote"',
    );
  });

  it('refuses anything that is not a matcher list', () => {
    for (const bad of [
      '',
      '{}',
      'job=g2way',
      'job="a" or vector(1)',
      'job="a"}) or up{x="1"',
      '1job="a"',
    ]) {
      expect(parseSelector(bad)).toBeNull();
    }
  });
});
