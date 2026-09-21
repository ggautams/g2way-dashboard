import type { JsonValue } from '@/lib/db/schema/shared';

/**
 * A small structural diff between two JSON snapshots, for the audit detail
 * view. Objects are compared key by key, arrays index by index; anything else
 * (including a change of type) is one `changed` entry at that path. No
 * dependency: the snapshots are API definitions, policies, key sessions and
 * account summaries, where a path-level list reads better than a text diff.
 */

export type DiffEntry =
  | { kind: 'added'; path: string; after: JsonValue }
  | { kind: 'removed'; path: string; before: JsonValue }
  | { kind: 'changed'; path: string; before: JsonValue; after: JsonValue };

type Container = JsonValue[] | { [key: string]: JsonValue };

function isObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isContainer(value: JsonValue): value is Container {
  return typeof value === 'object' && value !== null;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function child(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  if (IDENTIFIER.test(key)) return path === '' ? key : `${path}.${key}`;
  return `${path}[${JSON.stringify(key)}]`;
}

/**
 * The differences from `before` to `after`, in document order. A `null` or
 * missing snapshot (a creation, a deletion) diffs against nothing: every
 * top-level field of the other side is added or removed. The root is path `''`.
 */
export function diffJson(before: JsonValue | null, after: JsonValue | null): DiffEntry[] {
  const out: DiffEntry[] = [];
  if (before === null) {
    if (after === null) return out;
    if (!isContainer(after)) return [{ kind: 'added', path: '', after }];
    walk(Array.isArray(after) ? [] : {}, after, '', out);
  } else if (after === null) {
    if (!isContainer(before)) return [{ kind: 'removed', path: '', before }];
    walk(before, Array.isArray(before) ? [] : {}, '', out);
  } else {
    walk(before, after, '', out);
  }
  return out;
}

function walk(before: JsonValue, after: JsonValue, path: string, out: DiffEntry[]) {
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let i = 0; i < length; i++) {
      const at = child(path, i);
      if (i >= before.length) out.push({ kind: 'added', path: at, after: after[i] });
      else if (i >= after.length) out.push({ kind: 'removed', path: at, before: before[i] });
      else walk(before[i], after[i], at, out);
    }
    return;
  }
  if (isObject(before) && isObject(after)) {
    const keys = [...Object.keys(before)];
    for (const key of Object.keys(after)) if (!Object.hasOwn(before, key)) keys.push(key);
    for (const key of keys) {
      const at = child(path, key);
      const had = Object.hasOwn(before, key);
      const has = Object.hasOwn(after, key);
      if (!had) out.push({ kind: 'added', path: at, after: after[key] });
      else if (!has) out.push({ kind: 'removed', path: at, before: before[key] });
      else walk(before[key], after[key], at, out);
    }
    return;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    out.push({ kind: 'changed', path, before, after });
  }
}
