/**
 * An OpenAPI 3.x or Swagger 2.0 document → a starting `ApiDefinition`, for the
 * designer to open as an unsaved draft. It maps what a gateway definition has
 * an equivalent for (name, upstream, auth scheme) and says, as notes, what it
 * did not or could not; the designer, and then the gateway's validation, have
 * the last word. Universal and pure.
 */

import { slugify } from './draft';
import type { ApiDefinition } from './list';
import { parseRaw } from './raw';

export type ImportResult =
  { ok: true; draft: ApiDefinition; notes: string[] } | { ok: false; error: string };

type Doc = Record<string, unknown>;

const isObject = (value: unknown): value is Doc =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/** Parses JSON, or YAML when it is not JSON, and maps the document. */
export function importOpenApi(source: string): ImportResult {
  const trimmed = source.trim();
  if (trimmed === '') return { ok: false, error: 'Paste or choose an OpenAPI document.' };
  const parsed = parseRaw(trimmed, trimmed.startsWith('{') ? 'json' : 'yaml');
  if (!parsed.ok) return { ok: false, error: `Not valid JSON or YAML: ${parsed.error}` };
  if (!isObject(parsed.value)) return { ok: false, error: 'The document is not an object.' };
  const doc = parsed.value;
  if (typeof doc.openapi === 'string' && doc.openapi.startsWith('3.')) return mapDocument(doc, 3);
  if (doc.swagger === '2.0') return mapDocument(doc, 2);
  return {
    ok: false,
    error: 'Not an OpenAPI 3.x or Swagger 2.0 document (no "openapi: 3.x" or "swagger: 2.0").',
  };
}

function mapDocument(doc: Doc, version: 2 | 3): ImportResult {
  const notes: string[] = [];
  const info = isObject(doc.info) ? doc.info : {};
  const name = text(info.title) ?? 'Imported API';
  if (text(info.title) === undefined)
    notes.push('The document has no info.title; named it "Imported API".');
  const id = slugify(name) || 'imported-api';

  const target = version === 3 ? serverUrl3(doc, notes) : serverUrl2(doc, notes);
  const draft: ApiDefinition = {
    api_id: id,
    name,
    listen_path: `/${id}/`,
    target_url: target ?? '',
    active: true,
  };
  const auth = mapSecurity(doc, version, notes);
  if (auth !== undefined) draft.auth = auth;

  const paths = isObject(doc.paths) ? Object.keys(doc.paths).length : 0;
  notes.push(
    `${paths} path${paths === 1 ? '' : 's'} in the document; all of them are proxied under the listen path. Path allow/block lists are not generated.`,
  );
  return { ok: true, draft, notes };
}

/** OpenAPI 3: the first server, with its variables at their defaults. */
function serverUrl3(doc: Doc, notes: string[]): string | undefined {
  const servers = Array.isArray(doc.servers) ? doc.servers.filter(isObject) : [];
  const first = servers[0];
  const raw = first ? text(first.url) : undefined;
  if (raw === undefined) {
    notes.push('The document names no server; fill in the upstream URL.');
    return undefined;
  }
  const variables = isObject(first?.variables) ? first.variables : {};
  const url = raw.replace(/\{([^}]+)\}/g, (whole, variable: string) => {
    const spec = variables[variable];
    return isObject(spec) && typeof spec.default === 'string' ? spec.default : whole;
  });
  if (servers.length > 1) notes.push(`Used the first of ${servers.length} servers: ${url}.`);
  if (!/^https?:\/\//i.test(url)) {
    notes.push(`The server URL "${url}" is not absolute; fill in the upstream URL.`);
    return undefined;
  }
  return url;
}

/** Swagger 2: scheme (https preferred) + host + basePath. */
function serverUrl2(doc: Doc, notes: string[]): string | undefined {
  const host = text(doc.host);
  if (host === undefined) {
    notes.push('The document has no host; fill in the upstream URL.');
    return undefined;
  }
  const schemes = Array.isArray(doc.schemes)
    ? doc.schemes.filter((s) => typeof s === 'string')
    : [];
  const scheme = schemes.includes('https') ? 'https' : (schemes[0] ?? 'https');
  const basePath = text(doc.basePath) ?? '';
  return `${scheme}://${host}${basePath === '/' ? '' : basePath}`;
}

/**
 * The first security scheme the document requires globally (or declares, if
 * none is required), as the nearest g2way auth mode. With none, the API stays
 * on g2way's default token auth: the gateway never turns an API keyless
 * unless asked, and neither does an import.
 */
function mapSecurity(doc: Doc, version: 2 | 3, notes: string[]): ApiDefinition['auth'] | undefined {
  const schemes =
    version === 3
      ? isObject(doc.components) && isObject(doc.components.securitySchemes)
        ? doc.components.securitySchemes
        : {}
      : isObject(doc.securityDefinitions)
        ? doc.securityDefinitions
        : {};
  const required = Array.isArray(doc.security)
    ? doc.security.filter(isObject).flatMap((requirement) => Object.keys(requirement))
    : [];
  const chosen = required[0] ?? Object.keys(schemes)[0];
  const scheme = chosen === undefined ? undefined : schemes[chosen];
  if (!isObject(scheme)) {
    notes.push(
      'The document declares no security scheme. The API keeps g2way’s default token auth; choose keyless in the designer if it really is public.',
    );
    return undefined;
  }
  const type = text(scheme.type);
  const label = `security scheme "${chosen}" (${type ?? 'unknown type'})`;

  if (type === 'apiKey') {
    if (scheme.in === 'header') {
      const header = text(scheme.name);
      notes.push(`Mapped ${label} to token auth on the ${header ?? 'Authorization'} header.`);
      return header && header.toLowerCase() !== 'authorization'
        ? { mode: 'auth_token', header }
        : undefined;
    }
    if (scheme.in === 'query' && text(scheme.name)) {
      notes.push(
        `Mapped ${label} to token auth read from the ${text(scheme.name)} query parameter.`,
      );
      return { mode: 'auth_token', query_param: text(scheme.name) };
    }
    if (scheme.in === 'cookie' && text(scheme.name)) {
      notes.push(`Mapped ${label} to token auth read from the ${text(scheme.name)} cookie.`);
      return { mode: 'auth_token', cookie: text(scheme.name) };
    }
  }
  if ((type === 'http' && text(scheme.scheme)?.toLowerCase() === 'basic') || type === 'basic') {
    notes.push(`Mapped ${label} to basic auth.`);
    return { mode: 'basic_auth' };
  }
  if (type === 'http' && text(scheme.scheme)?.toLowerCase() === 'bearer') {
    notes.push(
      `Mapped ${label} to JWT; set the signing method and key (or JWKS URL) before saving.`,
    );
    return { mode: 'jwt', signing_method: 'rs256' };
  }
  if (type === 'openIdConnect') {
    const discovery = text(scheme.openIdConnectUrl) ?? '';
    const issuer = discovery.replace(/\/\.well-known\/openid-configuration\/?$/, '');
    notes.push(`Mapped ${label} to OIDC with issuer ${issuer || '(unknown)'}; add the audiences.`);
    return { mode: 'oidc', issuer_url: issuer, audiences: [] };
  }
  if (type === 'mutualTLS') {
    notes.push(`Mapped ${label} to mTLS.`);
    return { mode: 'mtls' };
  }
  notes.push(`No g2way equivalent for ${label}; the API keeps g2way’s default token auth.`);
  return undefined;
}
