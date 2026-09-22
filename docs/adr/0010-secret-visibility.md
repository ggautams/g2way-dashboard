# ADR-0010: Secret visibility for read-only roles

Date: 2026-09-23 · Status: accepted · Builds on: ADR-0005, ADR-0006, ADR-0008, ADR-0009

## Context

Until now the BFF passed `GET` bodies through untouched. The pages handed whole
API definitions, policies and key sessions to the designers, and the History
tab (ADR-0008 §6) passed stored versions on as they were. So every role with
`apis:read`, `policies:read` or `keys:read` could read live credentials. That
included a viewer, and it included an editor looking at a key: an hmac
session's plaintext `hmac.secret` (vendored `hmac.md`), a JWT HS256 shared
secret, and an `Authorization: Bearer …` header sent upstream by schema sync.
ADR-0008 §6 left one rule: the BFF and history redact together or not at all.

## Decisions

1. **A role that cannot write a kind cannot see its secrets.**

   | Kind           | Secrets shown only with | Hidden from (today)   |
   | -------------- | ----------------------- | --------------------- |
   | API definition | `apis:write`            | viewer                |
   | Policy         | `policies:write`        | viewer                |
   | Key session    | `keys:write`            | viewer **and editor** |

   The rule is `mayReveal(role, kind)` in `src/lib/secrets/redact.ts`, built on
   `can()` (ADR-0005 §1), so it follows the permission matrix and not role
   names. An editor edits API definitions, so it sees their secrets. It cannot
   mint keys, so it does not see key credentials.

2. **The mask is one fixed string, `[secret hidden]`** (`SECRET_MASK`). It
   replaces a present string or numeric value. `redactSecrets(kind, body)` is
   pure and keeps the shape:
   - it never adds or removes a field;
   - `null` and absent fields stay as they are, so "no secret set" can still be
     told from "secret hidden";
   - booleans are never touched.

   The audit log uses `[redacted]` instead. The two markers are kept apart
   deliberately, because the write guard (§5) refuses this one.

3. **Which fields are secret.** The list is explicit and typed, per kind. Each
   entry is a `SecretPath<T>` checked against `contracts/g2way.d.ts`, so a
   `sync:g2way` that renames or moves one of these fields fails `tsc`. The
   inventory was taken from the contract JSDoc and the vendored docs.
   - **Key session:**
     - `hmac.secret`: a live HMAC credential stored in plaintext (`hmac.md`).
     - `basic_auth.password_hash`: a bcrypt hash. It is not the password, but
       it can be cracked offline.
   - **API definition:**
     - `auth.secret`: the JWT HS256 shared secret. `public_key_pem` and
       `jwks_url` are public and stay visible.
     - `transform_headers.request.add.*`: headers added to the upstream
       request, which is where upstream credentials go.
     - `graphql.schema_sync.headers.*`: introspection auth. `graphql.md`
       gives `authorization: Bearer …` as its example.
     - `graphql.data_sources.*.headers.*`: UDG upstream headers, literal or
       templated.
     - `graphql.supergraph.subgraphs.[].headers.*`: subgraph auth.
     - The same four maps again under `versioning.versions.*`, which can
       override them per version.
   - **Policy:** nothing. A policy carries access, rate and quota only.

   A header map is masked as a whole: every value, `X-Trace` as well as
   `Authorization`. A path cannot tell a credential header from any other, and
   these maps exist to reach upstreams. `transform_headers.response.add` and
   mock-response headers go to clients, not upstream, so they are not on the
   path list.

   The contract has **no** upstream TLS client key and no OIDC client secret.
   OIDC verifies against JWKS. mTLS matches certificate fingerprints, and its
   PEMs are process configuration (`tls.md`), never part of a definition. When
   g2way adds such a field, it gets a path here, and the drift check
   (`contracts/watch.json`) is how the next session finds out.

   **Name fallback, as a second line of defence:** a string or number under a
   property named like `secret|passw|private[-_]?key|credential|api[-_]?key|authorization|…token`
   is masked at any depth. This covers untyped JSON (plugin `config`, UDG
   `variables`), response-side headers such as `X-Api-Key`, and fields that
   upstream adds before the path list catches up. It is narrower than the audit
   rule (ADR-0006 §4), so `auth.cookie`, `auth.header` and `query_param`, which
   say _where_ a credential goes, stay visible. Tests pin both the paths and
   the fallback.

   **Credentials embedded in URLs** (_added 2026-09-23_). Masking a whole
   URL would hide the routing a viewer is there to read, so only the
   credential parts are replaced, by `SECRET_URL_MASK`: the mask
   percent-encoded (`%5Bsecret%20hidden%5D`), so the result still parses as a
   URL.
   - **Which parts:** the userinfo (`user:pass@`, or a lone token as the
     user) becomes the mask. So does the value of every query parameter whose
     name, after decoding, lower-casing and `-` → `_`, is on the explicit
     `CREDENTIAL_QUERY_PARAMS` list (`src/lib/secrets/url.ts`): `api_key`,
     `key`, `token`, `access_token`, `secret`, `password`, `sig`, `signature`,
     the AWS and GCS presigning names, and similar. Every entry is pinned by a
     test. The list is explicit because a pattern would also catch `keyword`
     or `token_type`. Scheme, host, port, path, other parameters and the
     fragment stay as they are. An empty value stays empty.
   - **Which fields** (`SECRET_URL_PATHS`, typed like `SECRET_PATHS`):
     `target_url`, `target_list.[]`, `service_discovery.endpoint`,
     `graphql.schema_sync.url`, `graphql.data_sources.*.url` and
     `graphql.supergraph.subgraphs.[].url`, again under
     `versioning.versions.*`. `target_list` and the discovery endpoint follow
     `target_url`'s rules upstream, so they are listed with it.
   - **Fallback:** as with the name rule, any other string that reads as
     `scheme://…` gets the same treatment. That covers a plugin config's URL.
     It is safe to apply everywhere because it never hides more than the
     credential parts.
   - The masking is textual, not `new URL()`. UDG URLs are minijinja
     templates (`http://users/{{ args.id }}`), which a URL parser would
     reject or re-encode.
   - The write guard (§5) finds the URL form too: `findMasked` and the
     non-JSON check use `containsMask`. It matches the plain mask anywhere
     inside a string, and the encoded form in any hex case, with `%20` or `+`
     for the space.

4. **Where redaction is applied.** Every place a gateway body can reach a
   browser:
   - **The BFF proxy** (`src/lib/g2/proxy.ts`, `SECRET_READS`): a successful
     `GET /g2/apis`, `/g2/apis/{id}`, `/g2/policies`, `/g2/policies/{id}` or
     `/g2/keys/{key}` is parsed and each record redacted, unless the role may
     reveal that kind. If the body is not JSON it cannot be redacted, so it is
     not passed on: the proxy answers 502 (fail closed). Error answers pass
     through untouched. `GET /g2/keys` lists hashes only, so it is not
     redacted.
   - **Page loaders**: `loadApi`, `loadPolicy` and `loadKey` take the caller's
     role as a required argument and return the body as that role may see it.
     The three `/…/view/…` pages pass `user.role`. `key-metadata.ts` reads a
     key only to confirm that it exists, and uses the least privileged view
     (`'viewer'`).
   - **History**: `toHistoryEntry(version, role)` in
     `src/lib/designer/load-history.ts`, the single seam where a stored version
     becomes browser data. The `config_versions` table itself stays unredacted
     (ADR-0008 §2), so rollback still restores the real secret for a writer.
   - **List pages** (`/apis`, `/policies`, `/keys`) use the unredacted list
     loaders, but send only summaries on (`summarise`, `summarisePolicy`,
     `toKeyListRow`). No secret is in a summary.
   - **The bundle export** runs in the browser from the BFF's `GET /g2/apis`,
     so a viewer's bundle is masked. The README then says the bundle is not
     deployable as it stands, instead of claiming that it is unredacted.

   `src/app/(app)/secret-visibility.test.ts` is a static guard for this list.
   It checks that no page reaches the gateway client itself, that every
   redacting-loader call passes `user.role`, that each page giving a designer a
   stored body loads it through those loaders, and that the list pages only
   summarise.

5. **A masked value can never be written back.** Designers are read-only for
   the roles that see masks, and history's "Load into the draft" is offered
   only to writers. On top of that, the BFF refuses any write whose body
   contains `SECRET_MASK`: as a value anywhere in JSON, or anywhere in a
   non-JSON body. The mask could only have come from a read by a role that
   could not see the secret, so writing it would replace the real secret with
   the placeholder. The refusal:
   - is answered with **422** in the `{"error"}` envelope, naming the paths;
   - never reaches the gateway;
   - is audited as `denied` (best effort), like every other refusal
     (ADR-0006 §1). The status is 422, not 403, because nothing about the
     role is wrong.

6. **The audit log is unchanged.** Its snapshots are already redacted on the
   way into the table (ADR-0006 §4, `[redacted]`), which is stricter than this
   ADR in most places, and `audit:read` is held only by admin and owner. Both
   hold every write permission, so no reader of the log is a role this ADR
   hides anything from. If a role ever gets `audit:read` without the write
   permissions, `/audit/[id]` must run `redactFor` over its snapshots too.
   _Amended 2026-09-23:_ the audit redactor now walks this ADR's typed path
   lists and URL masking as well as its own name rule (ADR-0006 §4
   addendum). An upstream header like `X-Upstream-Key` and a password in
   `target_url` are no longer stored in audit snapshots. `config_versions`
   stays unredacted (§4).

7. **The gateway still holds everything.** This is presentation, enforced
   server-side before a body leaves the dashboard. g2way stores and returns
   every secret to anyone with the admin secret. The dashboard's own
   `config_versions` table and the BFF's before/after reads for the audit row
   see real values. Only what goes to a browser is masked.

## Consequences

- A viewer sees that a JWT secret or an hmac secret exists, never its value.
  The "What does this key allow" resolver reports credentials by presence, so
  it works the same on a masked session.
- An editor now sees `[secret hidden]` on hmac and basic-auth keys, where it
  used to see the secret.
- A secret-bearing `GET` for a read-only role costs one JSON parse and
  re-serialise. Writers still get the gateway's bytes streamed through.
- Adding a secret field upstream means adding a path to `SECRET_PATHS` and a
  test case. The name fallback covers the gap until then only if the field's
  name looks like a secret.
- ADR-0008 §6's open question is closed: history redacts together with the
  BFF.
