/**
 * Credentials embedded in a URL (ADR-0010 §3): the userinfo (`user:pass@`)
 * and query parameters named like a credential (`?api_key=…`). Universal and
 * dependency-free, shared by the secret-visibility redactor and the audit
 * redactor (ADR-0006 §4).
 *
 * Only those parts are replaced; scheme, host, port, path, the other query
 * parameters and the fragment stay as they are, so a reader still sees where
 * a request goes. The work is textual, not `new URL()`, because UDG data-source
 * URLs are minijinja templates (`http://users/{{ args.id }}`) that a URL
 * parser would reject or re-encode.
 */

/**
 * Query parameter names whose values are credentials, compared after
 * percent-decoding, lower-casing and turning `-` into `_` (so `X-Amz-Signature`
 * and `api-key` match). Explicit on purpose: a pattern would also catch
 * `keyword` or `token_type`. Every entry is pinned by a test.
 */
export const CREDENTIAL_QUERY_PARAMS: ReadonlySet<string> = new Set([
  // API keys (Google uses a bare `key`).
  'api_key',
  'apikey',
  'key',
  'x_api_key',
  // Bearer and OAuth tokens.
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'auth',
  'auth_token',
  'authorization',
  'bearer',
  'jwt',
  // Shared secrets and passwords.
  'secret',
  'client_secret',
  'password',
  'passwd',
  'pwd',
  'private_key',
  'credential',
  'credentials',
  'session',
  'session_id',
  'sessionid',
  // Signed URLs: Azure SAS `sig`, generic `signature`, AWS SigV4 and GCS presigning.
  'sig',
  'signature',
  'x_amz_signature',
  'x_amz_credential',
  'x_amz_security_token',
  'x_goog_signature',
  'x_goog_credential',
]);

/** `scheme://`, then the authority up to the first `/`, `?` or `#`. */
const SCHEME_AUTHORITY = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#]*)/;

/** Whether `value` reads as an absolute URL with an authority (`scheme://…`). */
export function looksLikeUrl(value: string): boolean {
  return SCHEME_AUTHORITY.test(value);
}

function normalisedName(raw: string): string {
  let name = raw.replace(/\+/g, ' ');
  try {
    name = decodeURIComponent(name);
  } catch {
    // A malformed escape: compare the raw text.
  }
  return name.trim().toLowerCase().replace(/-/g, '_');
}

/** Whether a query parameter named `name` (raw, as in the URL) carries a credential. */
export function isCredentialParam(name: string): boolean {
  return CREDENTIAL_QUERY_PARAMS.has(normalisedName(name));
}

/**
 * `url` with its userinfo and every credential query value replaced by `mask`
 * (which should be URL-safe: percent-encoded). An empty value stays empty, so
 * "no credential set" can still be told from "credential hidden". A string
 * without these parts comes back unchanged; userinfo is only recognised after
 * `scheme://`, query parameters wherever a `?` is.
 */
export function maskUrlCredentials(url: string, mask: string): string {
  const hash = url.indexOf('#');
  const fragment = hash === -1 ? '' : url.slice(hash);
  let rest = hash === -1 ? url : url.slice(0, hash);

  const question = rest.indexOf('?');
  let query = question === -1 ? null : rest.slice(question + 1);
  rest = question === -1 ? rest : rest.slice(0, question);

  const authority = SCHEME_AUTHORITY.exec(rest);
  if (authority !== null) {
    const [whole, scheme, hostPart] = authority;
    const at = hostPart.lastIndexOf('@');
    if (at > 0) rest = `${scheme}${mask}${hostPart.slice(at)}${rest.slice(whole.length)}`;
  }

  if (query !== null) {
    query = query
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=');
        if (eq === -1 || eq === pair.length - 1) return pair;
        const name = pair.slice(0, eq);
        return isCredentialParam(name) ? `${name}=${mask}` : pair;
      })
      .join('&');
  }

  return `${rest}${query === null ? '' : `?${query}`}${fragment}`;
}
