import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AUTH_MODES,
  filterApis,
  parseApiFilter,
  summarise,
  type ApiDefinition,
  type AuthMode,
} from './list';

const users: ApiDefinition = {
  api_id: 'users',
  name: 'Users service',
  listen_path: '/users/',
  target_url: 'http://users.svc:8000',
};
const orders: ApiDefinition = {
  api_id: 'orders',
  name: 'Orders',
  listen_path: '/orders/',
  target_url: 'http://unused',
  target_list: ['http://orders-a:80', 'http://orders-b:80'],
  active: false,
  auth: { mode: 'keyless' },
};

describe('summarise', () => {
  it('applies g2way’s defaults the OpenAPI document leaves out', () => {
    expect(summarise(users)).toEqual({
      apiId: 'users',
      name: 'Users service',
      listenPath: '/users/',
      targets: ['http://users.svc:8000'],
      active: true,
      authMode: 'auth_token',
    });
  });

  it('prefers a non-empty target_list over target_url', () => {
    expect(summarise(orders)).toMatchObject({
      targets: ['http://orders-a:80', 'http://orders-b:80'],
      active: false,
      authMode: 'keyless',
    });
    expect(summarise({ ...users, target_list: [] }).targets).toEqual(['http://users.svc:8000']);
  });
});

describe('AUTH_MODES', () => {
  it('lists every mode of the contract’s AuthConfig, once', () => {
    expectTypeOf<(typeof AUTH_MODES)[number]>().toEqualTypeOf<AuthMode>();
    expect(new Set(AUTH_MODES).size).toBe(AUTH_MODES.length);
  });
});

describe('parseApiFilter', () => {
  it('reads q, state and auth, treating anything unknown as all', () => {
    expect(parseApiFilter({ q: ' ord ', state: 'inactive', auth: 'jwt' })).toEqual({
      q: 'ord',
      state: 'inactive',
      auth: 'jwt',
    });
    expect(parseApiFilter({ state: 'bogus', auth: ['nope', 'jwt'] })).toEqual({
      q: '',
      state: 'all',
      auth: 'all',
    });
  });
});

describe('filterApis', () => {
  const all = [users, orders].map(summarise);
  const ids = (filter: Parameters<typeof parseApiFilter>[0]) =>
    filterApis(all, parseApiFilter(filter)).map((api) => api.apiId);

  it('searches name, id, listen path and targets, case-insensitively', () => {
    expect(ids({})).toEqual(['users', 'orders']);
    expect(ids({ q: 'SERVICE' })).toEqual(['users']);
    expect(ids({ q: '/orders' })).toEqual(['orders']);
    expect(ids({ q: 'orders-b' })).toEqual(['orders']);
  });

  it('filters by state and auth mode, combined with the search', () => {
    expect(ids({ state: 'active' })).toEqual(['users']);
    expect(ids({ state: 'inactive' })).toEqual(['orders']);
    expect(ids({ auth: 'auth_token' })).toEqual(['users']);
    expect(ids({ auth: 'keyless', q: 'users' })).toEqual([]);
  });
});
