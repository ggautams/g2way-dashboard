import { describe, expect, it } from 'vitest';
import { diffJson } from './diff';

describe('diffJson', () => {
  it('lists changed, added and removed paths in document order', () => {
    expect(
      diffJson(
        { name: 'a', listen_path: '/old/', tags: ['x', 'y'], cors: { enabled: true } },
        { name: 'a', listen_path: '/new/', tags: ['x'], cors: {}, auth: { mode: 'keyless' } },
      ),
    ).toEqual([
      { kind: 'changed', path: 'listen_path', before: '/old/', after: '/new/' },
      { kind: 'removed', path: 'tags[1]', before: 'y' },
      { kind: 'removed', path: 'cors.enabled', before: true },
      { kind: 'added', path: 'auth', after: { mode: 'keyless' } },
    ]);
  });

  it('diffs a creation and a deletion against nothing', () => {
    expect(diffJson(null, { a: 1, b: [2] })).toEqual([
      { kind: 'added', path: 'a', after: 1 },
      { kind: 'added', path: 'b', after: [2] },
    ]);
    expect(diffJson({ a: 1 }, null)).toEqual([{ kind: 'removed', path: 'a', before: 1 }]);
    expect(diffJson([1], null)).toEqual([{ kind: 'removed', path: '[0]', before: 1 }]);
    expect(diffJson(null, null)).toEqual([]);
  });

  it('reports a type change as one change, and quotes awkward keys', () => {
    expect(diffJson({ 'X-Env': 'a', v: [1] }, { 'X-Env': 'b', v: { 0: 1 } })).toEqual([
      { kind: 'changed', path: '["X-Env"]', before: 'a', after: 'b' },
      { kind: 'changed', path: 'v', before: [1], after: { 0: 1 } },
    ]);
  });

  it('finds nothing between equal documents', () => {
    expect(diffJson({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toEqual([]);
  });
});
