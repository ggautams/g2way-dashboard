/**
 * The resources a designer edits, and how each is read, saved and deleted
 * through the BFF. The shared save bar and delete button take a `kind` rather
 * than functions, so a Server Component can render them. Universal.
 */

import type { ApiDefinition } from '@/lib/apis/list';
import { deleteApi, fetchStored, saveApi } from '@/lib/apis/save';
import type { G2Client } from '@/lib/g2/client';
import { deleteKey, fetchStoredKey, saveKey } from '@/lib/keys/save';
import type { KeySession } from '@/lib/keys/session';
import type { Policy } from '@/lib/policies/list';
import { deletePolicy, fetchStoredPolicy, savePolicy } from '@/lib/policies/save';
import type { StoredResult, WriteResult } from './write';

export type ResourceKinds = { api: ApiDefinition; policy: Policy; key: KeySession };
export type ResourceKind = keyof ResourceKinds;

export type Resource<T> = {
  /** How the UI names one: "API", "policy". */
  noun: string;
  /**
   * The id a draft names. A key's session names none (keys are addressed by
   * hash), so its screens hand the hash to the save bar as `id`.
   */
  idOf(draft: T): string;
  listHref: string;
  viewHref(id: string): string;
  /** What waits for `POST /g2/reload` (CLAUDE.md: every write screen says so), or that nothing does. */
  notLive: string;
  fetchStored(client: G2Client, id: string): Promise<StoredResult<T>>;
  /** `id` is the resource's id (a key's hash); API definitions and policies read theirs from the draft. */
  save(client: G2Client, draft: T, creating: boolean, id: string): Promise<WriteResult>;
  remove(client: G2Client, id: string): Promise<WriteResult>;
};

export const RESOURCES: { [K in ResourceKind]: Resource<ResourceKinds[K]> } = {
  api: {
    noun: 'API',
    idOf: (draft) => draft.api_id,
    listHref: '/apis',
    viewHref: (id) => `/apis/view/${encodeURIComponent(id)}`,
    notLive: 'Nothing routes differently until the gateway reloads.',
    fetchStored,
    save: saveApi,
    remove: deleteApi,
  },
  policy: {
    noun: 'policy',
    idOf: (draft) => draft.policy_id,
    listHref: '/policies',
    viewHref: (id) => `/policies/view/${encodeURIComponent(id)}`,
    notLive: 'Keys referencing it are unaffected until the gateway reloads.',
    fetchStored: fetchStoredPolicy,
    save: savePolicy,
    remove: deletePolicy,
  },
  key: {
    noun: 'key',
    idOf: () => '',
    listHref: '/keys',
    viewHref: (hash) => `/keys/view/${encodeURIComponent(hash)}`,
    notLive: 'Key changes are live at once: the gateway reads keys from storage, no reload needed.',
    fetchStored: fetchStoredKey,
    // Creating goes through `createKey` instead, which returns the raw key once.
    save: (client, draft, creating, hash) =>
      creating
        ? Promise.resolve({ ok: false, error: 'keys are created from the new-key page' })
        : saveKey(client, hash, draft),
    remove: deleteKey,
  },
};
