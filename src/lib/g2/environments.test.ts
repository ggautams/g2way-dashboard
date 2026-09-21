import { describe, expect, it } from 'vitest';
import { inspect } from 'node:util';
import {
  RegistryConfigError,
  UnknownEnvironmentError,
  envPrefix,
  listEnvironments,
  parseEnvironments,
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
