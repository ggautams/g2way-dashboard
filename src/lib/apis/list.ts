/**
 * The API list's view of `ApiDefinition`s: one summary row per definition, and
 * the search/filter state carried in the page's query string. Universal and
 * pure, so the page and its tests share it.
 */

import type { components } from '../../../contracts/g2way.d.ts';

export type ApiDefinition = components['schemas']['ApiDefinition'];
export type AuthMode = components['schemas']['AuthConfig']['mode'];

/**
 * Every auth mode, in the order the filter offers them. `satisfies` plus the
 * test keeps it in step with the contract's `AuthConfig` union.
 */
export const AUTH_MODES = [
  'auth_token',
  'jwt',
  'oidc',
  'basic_auth',
  'hmac',
  'mtls',
  'keyless',
] as const satisfies readonly AuthMode[];

export type ApiSummary = {
  apiId: string;
  name: string;
  listenPath: string;
  /** `target_url`, or the round-robin list when one is set (it wins, per the contract). */
  targets: string[];
  /** g2way's serde default is `true` (`api_definition.rs`); the OpenAPI omits it. */
  active: boolean;
  /** An absent `auth` means token auth: keyless must be asked for explicitly. */
  authMode: AuthMode;
};

export function summarise(api: ApiDefinition): ApiSummary {
  return {
    apiId: api.api_id,
    name: api.name,
    listenPath: api.listen_path,
    targets: api.target_list && api.target_list.length > 0 ? api.target_list : [api.target_url],
    active: api.active ?? true,
    authMode: api.auth?.mode ?? 'auth_token',
  };
}

export const API_STATES = ['all', 'active', 'inactive'] as const;
export type ApiState = (typeof API_STATES)[number];

export type ApiFilter = { q: string; state: ApiState; auth: AuthMode | 'all' };

type SearchParams = Record<string, string | string[] | undefined>;

function one(params: SearchParams, name: string): string {
  const value = params[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

/** The filter in `?q=&state=&auth=`; anything unrecognised means "all". */
export function parseApiFilter(params: SearchParams): ApiFilter {
  const state = one(params, 'state');
  const auth = one(params, 'auth');
  return {
    q: one(params, 'q'),
    state: (API_STATES as readonly string[]).includes(state) ? (state as ApiState) : 'all',
    auth: (AUTH_MODES as readonly string[]).includes(auth) ? (auth as AuthMode) : 'all',
  };
}

/**
 * The summaries matching `filter`, in the gateway's order (it sorts by id). The
 * search is a case-insensitive substring of the name, id, listen path or a target.
 */
export function filterApis(apis: readonly ApiSummary[], filter: ApiFilter): ApiSummary[] {
  const needle = filter.q.toLowerCase();
  return apis.filter(
    (api) =>
      (filter.state === 'all' || api.active === (filter.state === 'active')) &&
      (filter.auth === 'all' || api.authMode === filter.auth) &&
      (needle === '' ||
        [api.name, api.apiId, api.listenPath, ...api.targets].some((field) =>
          field.toLowerCase().includes(needle),
        )),
  );
}
