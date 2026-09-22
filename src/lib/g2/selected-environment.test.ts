import { describe, expect, it } from 'vitest';
import { parseEnvironments } from './environments';
import { pickEnvironmentId } from './selected-environment';

const registry = parseEnvironments({
  G2_ENVIRONMENTS: 'dev,prod',
  G2_ENV_DEV_URL: 'http://dev:9696',
  G2_ENV_DEV_SECRET: 's1',
  G2_ENV_PROD_URL: 'http://prod:9696',
  G2_ENV_PROD_SECRET: 's2',
  G2_DEFAULT_ENVIRONMENT: 'prod',
});

describe('pickEnvironmentId', () => {
  it('prefers an explicit override, as given, so an unknown one still fails where resolved', () => {
    expect(pickEnvironmentId(registry, { override: 'dev', remembered: 'prod' })).toBe('dev');
    expect(pickEnvironmentId(registry, { override: 'nope' })).toBe('nope');
  });

  it('uses the remembered choice while it is configured, else the default', () => {
    expect(pickEnvironmentId(registry, { remembered: 'dev' })).toBe('dev');
    expect(pickEnvironmentId(registry, { remembered: 'removed' })).toBe('prod');
    expect(pickEnvironmentId(registry, {})).toBe('prod');
  });
});
