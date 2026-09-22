import { describe, expect, it } from 'vitest';
import {
  accessProblem,
  addApi,
  addTypeFields,
  apiChoice,
  danglingApis,
  describeQueryDepth,
  entryOf,
  formatFieldList,
  grantedApis,
  isRestricted,
  parseFieldList,
  parseQueryDepth,
  removeApi,
  removeTypeFields,
  typeListOf,
  ungrantedApis,
  withAccessField,
  withApiEntry,
  withTypeFields,
  withTypeList,
  type AccessMap,
  type ApiAccess,
  type ApiChoice,
  type TypeFields,
} from './access';

const apis: ApiChoice[] = [
  { id: 'orders', name: 'Orders', graphql: false, authMode: 'auth_token', active: true },
  { id: 'graph', name: 'Graph', graphql: true, authMode: 'auth_token', active: true },
];

// `future_field` stands in for anything g2way adds that the matrix does not show.
const graphEntry = {
  disable_introspection: true,
  allowed_types: [{ name: 'Query', fields: ['user'] }],
  future_field: 'kept',
} as ApiAccess;

const access: AccessMap = { graph: graphEntry, gone: {} };

describe('adding and removing APIs', () => {
  it('adds an unrestricted entry, leaving existing ones alone', () => {
    const next = addApi(access, ' orders ');
    expect(next).toEqual({ graph: graphEntry, gone: {}, orders: {} });
    expect(next.graph).toBe(graphEntry);
    expect(addApi(undefined, 'orders')).toEqual({ orders: {} });
  });

  it('never replaces a granted entry, and ignores a blank id', () => {
    expect(addApi(access, 'graph')).toBe(access);
    expect(addApi(access, '  ')).toBe(access);
  });

  it('removes an entry; removing the last drops the field (every API)', () => {
    expect(removeApi(access, 'gone')).toEqual({ graph: graphEntry });
    expect(removeApi({ orders: {} }, 'orders')).toBeUndefined();
    expect(access).toHaveProperty('gone');
  });

  it('lists granted ids in map order', () => {
    expect(grantedApis(access)).toEqual(['graph', 'gone']);
    expect(grantedApis(undefined)).toEqual([]);
  });
});

describe('dangling and ungranted APIs', () => {
  it('finds granted ids the environment does not list', () => {
    expect(danglingApis(access, apis)).toEqual(['gone']);
    expect(danglingApis(undefined, apis)).toEqual([]);
  });

  it('offers only the APIs not yet granted', () => {
    expect(ungrantedApis(access, apis).map((api) => api.id)).toEqual(['orders']);
    expect(ungrantedApis(undefined, apis)).toEqual(apis);
  });

  it('reduces a definition to id, name and GraphQL-ness', () => {
    const def = {
      api_id: 'graph',
      name: 'Graph',
      listen_path: '/g/',
      target_url: 'http://upstream',
      graphql: { mode: 'proxy' },
    } as Parameters<typeof apiChoice>[0];
    expect(apiChoice(def)).toEqual({
      id: 'graph',
      name: 'Graph',
      graphql: true,
      authMode: 'auth_token',
      active: true,
    });
    expect(apiChoice({ ...def, active: false, auth: { mode: 'hmac' } })).toMatchObject({
      authMode: 'hmac',
      active: false,
    });
    expect(apiChoice({ ...def, graphql: null }).graphql).toBe(false);
  });
});

describe('editing an entry', () => {
  it('sets and clears fields, keeping unknown ones', () => {
    const off = withAccessField(graphEntry, 'disable_introspection', undefined);
    expect(off).not.toHaveProperty('disable_introspection');
    expect(off).toHaveProperty('future_field', 'kept');
    const deep = withAccessField(graphEntry, 'max_query_depth', 5);
    expect(deep).toMatchObject({ max_query_depth: 5, future_field: 'kept' });
  });

  it('replaces one entry in the map and no other', () => {
    const next = withApiEntry(access, 'gone', { disable_introspection: true });
    expect(next.graph).toBe(graphEntry);
    expect(next.gone).toEqual({ disable_introspection: true });
  });

  it('reads a malformed entry or list as empty rather than failing', () => {
    const bad = { x: null, y: { allowed_types: 'nope' } } as unknown as AccessMap;
    expect(entryOf(bad, 'x')).toEqual({});
    expect(typeListOf(entryOf(bad, 'y'), 'allowed_types')).toEqual([]);
    expect(entryOf(undefined, 'x')).toEqual({});
  });

  it('knows when an entry restricts beyond the base grant', () => {
    expect(isRestricted({})).toBe(false);
    expect(isRestricted({ max_query_depth: null, allowed_types: [] })).toBe(false);
    expect(isRestricted({ max_query_depth: -1 })).toBe(true);
    expect(isRestricted(graphEntry)).toBe(true);
  });
});

describe('GraphQL type/field lists', () => {
  it('adds, edits and removes rows, keeping a row’s other keys', () => {
    const list = typeListOf(graphEntry, 'allowed_types');
    const added = addTypeFields(list);
    expect(added).toEqual([
      { name: 'Query', fields: ['user'] },
      { name: '', fields: [] },
    ]);
    const extra = [{ name: 'User', fields: ['id'], note: 'x' }] as unknown as TypeFields[];
    expect(withTypeFields(extra, 0, { fields: ['*'] })).toEqual([
      { name: 'User', fields: ['*'], note: 'x' },
    ]);
    expect(removeTypeFields(added, 0)).toEqual([{ name: '', fields: [] }]);
    expect(list).toHaveLength(1);
  });

  it('drops an emptied list (no restriction) and keeps the rest of the entry', () => {
    const cleared = withTypeList(graphEntry, 'allowed_types', []);
    expect(cleared).not.toHaveProperty('allowed_types');
    expect(cleared).toHaveProperty('future_field', 'kept');
    expect(withTypeList({}, 'restricted_types', [{ name: 'Mutation', fields: ['*'] }])).toEqual({
      restricted_types: [{ name: 'Mutation', fields: ['*'] }],
    });
  });

  it('parses a typed field list, and formats one back', () => {
    expect(parseFieldList(' user, orders ,,user\n*')).toEqual(['user', 'orders', '*']);
    expect(parseFieldList('')).toEqual([]);
    expect(formatFieldList(['user', 'orders'])).toBe('user, orders');
    expect(formatFieldList(undefined)).toBe('');
  });
});

describe('max_query_depth', () => {
  it('reads blank as inherit and accepts any whole number', () => {
    expect(parseQueryDepth(' ')).toEqual({ ok: true, value: undefined });
    expect(parseQueryDepth('7')).toEqual({ ok: true, value: 7 });
    expect(parseQueryDepth('-1')).toEqual({ ok: true, value: -1 });
    expect(parseQueryDepth('2.5').ok).toBe(false);
    expect(parseQueryDepth('deep').ok).toBe(false);
  });

  it('says what the override means', () => {
    expect(describeQueryDepth(undefined)).toMatch(/Inherits/);
    expect(describeQueryDepth(null)).toMatch(/Inherits/);
    expect(describeQueryDepth(0)).toMatch(/No depth limit/);
    expect(describeQueryDepth(-1)).toMatch(/No depth limit/);
    expect(describeQueryDepth(3)).toMatch(/At most 3 levels/);
  });
});

describe('accessProblem', () => {
  it('passes a well-formed map, and none', () => {
    expect(accessProblem(access)).toBeUndefined();
    expect(accessProblem(undefined)).toBeUndefined();
  });

  it('flags an empty api_id, an unnamed type and a fractional depth', () => {
    expect(accessProblem({ ' ': {} })).toMatch(/empty api_id/);
    expect(accessProblem({ graph: { restricted_types: [{ name: ' ', fields: ['x'] }] } })).toMatch(
      /graph: .*restricted_types/,
    );
    expect(accessProblem({ graph: { max_query_depth: 1.5 } })).toMatch(/whole number/);
  });
});
