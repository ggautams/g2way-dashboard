/**
 * "What does this key allow": one key's session folded with its applied
 * policy into the access g2way actually enforces. Universal and pure; the key
 * view's Effective access section renders it.
 *
 * The rules, from `contracts/g2way.d.ts` (`KeySession`, `Policy`, `ApiAccess`
 * rustdoc), `docs/g2way-map.md` (key and policy defaults) and the vendored
 * auth docs (`contracts/g2way-docs/{hmac,oidc,tls}.md`):
 *
 * - `apply_policies` holds at most one id (`KeySession::validate`); only the
 *   first is ever applied, and extras are reported, not folded.
 * - A non-empty `apply_policies` makes the policy's rate, quota **and** access
 *   replace the key's own entirely, including an absent (unlimited) one.
 * - An inactive key (`active: false`, a soft revoke) fails auth.
 * - A key whose `expires_at` is at or before now fails auth (`isExpired`).
 * - An inactive policy denies every key that references it.
 * - A **missing** policy denies the key: g2way answers `403` for "policy
 *   missing or inactive" in every stored-session auth mode (hmac.md, tls.md,
 *   oidc.md). So a `404` from `GET /g2/policies/{id}` is a denial. Any other
 *   failure to read it (storage down, gateway unreachable, a corrupt record)
 *   leaves the verdict **unknown**: the dashboard cannot tell what the data
 *   plane would do, and never guesses.
 * - An empty `access` grants every API in the org. It is expanded against the
 *   environment's `GET /g2/apis`, which lists stored definitions only: APIs
 *   loaded from `--apps-dir` files are granted too but cannot be listed
 *   (`UPSTREAM.md`, "`GET /g2/apis` lists stored definitions only").
 * - Per-API GraphQL rules apply only on GraphQL-configured APIs; a non-empty
 *   `allowed_types` wins and `restricted_types` is then ignored;
 *   `max_query_depth` null inherits, `n > 0` replaces, `<= 0` lifts.
 * - Credentials: a session carrying `basic_auth` or `hmac` data can be
 *   presented to `basic_auth` / `hmac` APIs; JWT and OIDC APIs build an
 *   ephemeral session from the token, so a stored key is never what their
 *   callers present. Only the presence of credentials is reported, never the
 *   password hash or the (plaintext) HMAC secret.
 */

import type { AuthMode } from '@/lib/apis/list';
import {
  entryOf,
  grantedApis,
  typeListOf,
  type AccessMap,
  type ApiChoice,
  type ApiChoices,
  type TypeFields,
} from '@/lib/designer/access';
import type { Outcome } from '@/lib/g2/gateway-status';
import type { Policy } from '@/lib/policies/list';
import { isExpired, type KeySession } from './session';
import { effectiveLimits, type EffectiveLimits } from './usage';

export type AccessStatus = 'allowed' | 'denied' | 'unknown';

export type AccessReasonCode =
  | 'key-inactive'
  | 'key-expired'
  | 'policy-inactive'
  | 'policy-missing'
  | 'policy-unreadable'
  | 'extra-policies';

/** Why the verdict is what it is. `denies`/`unknown` reasons set the status; notes do not. */
export type AccessReason = {
  code: AccessReasonCode;
  effect: 'denies' | 'unknown' | 'note';
  text: string;
};

/** How one API's auth mode meets this key's credentials. */
export type AuthFit =
  | { kind: 'usable'; text: string }
  | { kind: 'open'; text: string }
  | { kind: 'missing-credentials'; text: string }
  | { kind: 'not-key-auth'; text: string }
  | { kind: 'unknown'; text: string };

export type DepthRule =
  { kind: 'inherit' } | { kind: 'override'; depth: number } | { kind: 'unlimited' };

/** An entry's GraphQL restrictions, as g2way reads them. */
export type GraphqlRules = {
  /** Non-empty: only these (type, field) pairs may be selected. */
  allowed: TypeFields[];
  /** Blocked pairs; `restrictedIgnored` when `allowed` is non-empty (the allow list wins). */
  restricted: TypeFields[];
  restrictedIgnored: boolean;
  introspectionDisabled: boolean;
  depth: DepthRule;
};

export type ApiAccessRow = {
  apiId: string;
  /** From `GET /g2/apis`; `null` when the API is not listed there. */
  api: ApiChoice | null;
  /** The grant's GraphQL rules; `null` when the entry restricts nothing. */
  graphql: GraphqlRules | null;
  /** The entry has GraphQL rules but the API is listed as not GraphQL-configured. */
  graphqlIgnored: boolean;
  auth: AuthFit;
};

export type AccessGrant =
  | {
      /** Access could not be resolved (the applied policy is unreadable). */
      known: false;
    }
  | {
      known: true;
      /** Whose `access` map is in effect. */
      source: 'key' | 'policy';
      /** An empty map: every API in the org. */
      everyApi: boolean;
      rows: ApiAccessRow[];
      /**
       * `everyApi` could not be expanded because `GET /g2/apis` failed (or the
       * role cannot read APIs): the gateway's message, verbatim.
       */
      apisError: string | null;
    };

export type KeyAccess = {
  status: AccessStatus;
  reasons: AccessReason[];
  /** The rate and quota in effect, and whose they are. */
  limits: EffectiveLimits;
  /** Key fields present but replaced by the applied policy. */
  ignoredKeyFields: ('rate' | 'quota' | 'access')[];
  grant: AccessGrant;
  /** Which credentials the session carries; never their values. */
  credentials: { basicAuth: boolean; hmac: boolean };
  /** Unix seconds; `null`: never expires. */
  expiresAt: number | null;
};

export type ResolveKeyAccessInput = {
  session: KeySession;
  /** `GET /g2/policies/{apply_policies[0]}`; `null` when not read (or none applied). */
  policy: Outcome<Policy> | null;
  apis: ApiChoices;
  /** Unix seconds. */
  nowSecs: number;
};

export function resolveKeyAccess({
  session,
  policy,
  apis,
  nowSecs,
}: ResolveKeyAccessInput): KeyAccess {
  const reasons: AccessReason[] = [];
  const expiresAt = session.expires_at ?? null;

  if ((session.active ?? true) === false) {
    reasons.push({
      code: 'key-inactive',
      effect: 'denies',
      text: 'The key is revoked (active: false): g2way fails every request that presents it.',
    });
  }
  if (isExpired(expiresAt, nowSecs)) {
    reasons.push({
      code: 'key-expired',
      effect: 'denies',
      text: 'The key has expired (expires_at is in the past): g2way fails every request that presents it.',
    });
  }

  const applied = session.apply_policies ?? [];
  const policyId = applied[0];
  if (applied.length > 1) {
    reasons.push({
      code: 'extra-policies',
      effect: 'note',
      text: `apply_policies lists ${applied.length} policies; g2way applies at most one, and only ${policyId} is considered here. Saving this key would be refused.`,
    });
  }

  const limits = effectiveLimits(session, policy);
  const credentials = { basicAuth: session.basic_auth != null, hmac: session.hmac != null };
  let access: AccessMap | undefined = session.access;
  let source: 'key' | 'policy' = 'key';
  const ignoredKeyFields: KeyAccess['ignoredKeyFields'] = [];

  if (policyId !== undefined) {
    if (policy === null || !policy.ok) {
      const error = policy === null ? 'not loaded' : policy.error;
      const status = policy === null || policy.ok ? undefined : policy.status;
      const quoted = `GET /g2/policies/${policyId} failed: ${error}${status === undefined ? '' : ` (HTTP ${status})`}`;
      reasons.push(
        status === 404
          ? {
              code: 'policy-missing',
              effect: 'denies',
              text: `The applied policy ${policyId} does not exist, and g2way denies a key whose policy is missing. ${quoted}`,
            }
          : {
              code: 'policy-unreadable',
              effect: 'unknown',
              text: `The applied policy ${policyId} could not be read, so what this key allows is unknown. ${quoted}`,
            },
      );
      return {
        status: statusOf(reasons),
        reasons,
        limits,
        ignoredKeyFields: replacedFields(session),
        grant: { known: false },
        credentials,
        expiresAt,
      };
    }
    const value = policy.value;
    if ((value.active ?? true) === false) {
      reasons.push({
        code: 'policy-inactive',
        effect: 'denies',
        text: `The applied policy ${value.name} is inactive, which denies every key that references it.`,
      });
    }
    access = value.access;
    source = 'policy';
    ignoredKeyFields.push(...replacedFields(session));
  }

  return {
    status: statusOf(reasons),
    reasons,
    limits,
    ignoredKeyFields,
    grant: grantOf(access, source, apis, credentials),
    credentials,
    expiresAt,
  };
}

function statusOf(reasons: readonly AccessReason[]): AccessStatus {
  if (reasons.some((reason) => reason.effect === 'denies')) return 'denied';
  if (reasons.some((reason) => reason.effect === 'unknown')) return 'unknown';
  return 'allowed';
}

/** The key's own settings a policy replaces, where the key sets them. */
function replacedFields(session: KeySession): KeyAccess['ignoredKeyFields'] {
  const fields: KeyAccess['ignoredKeyFields'] = [];
  if (session.rate != null) fields.push('rate');
  if (session.quota != null) fields.push('quota');
  if (grantedApis(session.access).length > 0) fields.push('access');
  return fields;
}

function grantOf(
  access: AccessMap | undefined,
  source: 'key' | 'policy',
  apis: ApiChoices,
  credentials: KeyAccess['credentials'],
): AccessGrant {
  const listed = apis.ok ? apis.value : [];
  const byId = new Map(listed.map((api) => [api.id, api]));
  const granted = grantedApis(access);
  const everyApi = granted.length === 0;
  const ids = everyApi ? listed.map((api) => api.id) : granted;
  const rows = ids.map((apiId): ApiAccessRow => {
    const api = byId.get(apiId) ?? null;
    const graphql = graphqlRules(entryOf(access, apiId));
    return {
      apiId,
      api,
      graphql,
      graphqlIgnored: graphql !== null && api !== null && !api.graphql,
      auth: authFit(api?.authMode ?? null, credentials),
    };
  });
  return {
    known: true,
    source,
    everyApi,
    rows,
    apisError: apis.ok ? null : apis.error,
  };
}

/** An entry's GraphQL rules, or `null` when it restricts nothing. */
export function graphqlRules(entry: ReturnType<typeof entryOf>): GraphqlRules | null {
  const allowed = typeListOf(entry, 'allowed_types');
  const restricted = typeListOf(entry, 'restricted_types');
  const introspectionDisabled = entry.disable_introspection === true;
  const raw = entry.max_query_depth;
  const depth: DepthRule =
    raw == null
      ? { kind: 'inherit' }
      : raw <= 0
        ? { kind: 'unlimited' }
        : { kind: 'override', depth: raw };
  if (
    allowed.length === 0 &&
    restricted.length === 0 &&
    !introspectionDisabled &&
    depth.kind === 'inherit'
  ) {
    return null;
  }
  return {
    allowed,
    restricted,
    restrictedIgnored: allowed.length > 0 && restricted.length > 0,
    introspectionDisabled,
    depth,
  };
}

/** How an API's auth mode meets the key's credentials. `mode` is `null` for an unlisted API. */
export function authFit(mode: AuthMode | null, credentials: KeyAccess['credentials']): AuthFit {
  switch (mode) {
    case null:
      return {
        kind: 'unknown',
        text: 'Not listed by GET /g2/apis: deleted, or loaded from an --apps-dir file.',
      };
    case 'keyless':
      return {
        kind: 'open',
        text: 'Keyless: open to every caller, so this grant changes nothing here.',
      };
    case 'auth_token':
      return { kind: 'usable', text: 'Token auth: callers present the key itself.' };
    case 'mtls':
      return {
        kind: 'usable',
        text: 'mTLS: usable only if this session is provisioned under a certificate fingerprint (mtls:…).',
      };
    case 'basic_auth':
      return credentials.basicAuth
        ? { kind: 'usable', text: 'Basic auth: the session carries a password hash.' }
        : {
            kind: 'missing-credentials',
            text: 'Basic auth, but the session carries no basic_auth data: it cannot authenticate here.',
          };
    case 'hmac':
      return credentials.hmac
        ? { kind: 'usable', text: 'HMAC: the session carries a shared secret.' }
        : {
            kind: 'missing-credentials',
            text: 'HMAC, but the session carries no hmac data: it cannot authenticate here.',
          };
    case 'jwt':
    case 'oidc':
      return {
        kind: 'not-key-auth',
        text: `${mode === 'jwt' ? 'JWT' : 'OIDC'}: g2way builds an ephemeral session from the token, so callers never present this key.`,
      };
  }
}
