'use client';

import { Field, Toggle, useSyncedText } from '@/components/designer/fields';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  AUTH_DEFAULTS,
  formatPolicyMap,
  HMAC_ALGORITHMS,
  jwtKeySource,
  parsePolicyMap,
  withHmacAlgorithm,
  withJwtKeySource,
  withProp,
  withSigningMethod,
  type AuthConfig,
  type AuthField,
  type AuthHelp,
  type AuthOf,
  type JwtSigningMethod,
} from '@/lib/apis/auth';
import { SECRET_MASK, containsMask } from '@/lib/secrets/redact';
import { LinesField, NumberField, TextField } from './form-inputs';

type Problems = Partial<Record<AuthField, string>>;

type Props = {
  /** The auth config in effect (`effectiveAuth`): never undefined, so token auth has settings too. */
  auth: AuthConfig;
  onChange: (auth: AuthConfig) => void;
  /** The definition's auth as loaded, for restoring key material; `undefined` when creating. */
  original: AuthConfig | undefined;
  help: AuthHelp;
  problems: Problems;
  /** Radix selects ignore a disabled fieldset, so they are told directly. */
  readOnly: boolean;
};

/**
 * The settings of the draft's auth mode, every one `AuthConfig` has, each
 * edited in place with `withProp` so nothing else in the config moves. Blank
 * means g2way's default (shown as the placeholder), except where a value is
 * required. A secret masked for a read-only role (ADR-0010) is never shown as
 * a value, only as hidden.
 */
export function AuthSettings({ auth, onChange, original, help, problems, readOnly }: Props) {
  const fieldHelp = help[auth.mode].fields;
  const id = (field: AuthField) => `auth-${field}`;
  switch (auth.mode) {
    case 'keyless':
      return (
        <p className="text-xs text-warning md:col-span-2">
          Keyless: every request is forwarded without a credential. Only for APIs meant to be
          public.
        </p>
      );
    case 'mtls':
      return (
        <p className="text-xs text-muted md:col-span-2">
          No settings: the gateway&apos;s TLS listener must verify client certificates (a gateway
          flag), and each certificate maps to a key there.
        </p>
      );
    case 'auth_token': {
      const set = <K extends keyof AuthOf<'auth_token'>>(
        key: K,
        value: AuthOf<'auth_token'>[K] | undefined,
      ) => onChange(withProp(auth, key, value));
      return (
        <>
          <HeaderField auth={auth} help={fieldHelp} problems={problems} onChange={onChange} />
          <TextField
            id={id('query_param')}
            label="Query parameter"
            help={fieldHelp.query_param ?? ''}
            problem={problems.query_param}
            value={auth.query_param}
            placeholder="none"
            blank="unset"
            onChange={(value) => set('query_param', value)}
          />
          <TextField
            id={id('cookie')}
            label="Cookie"
            help={fieldHelp.cookie ?? ''}
            problem={problems.cookie}
            value={auth.cookie}
            placeholder="none"
            blank="unset"
            onChange={(value) => set('cookie', value)}
          />
        </>
      );
    }
    case 'jwt':
      return (
        <JwtSettings
          auth={auth}
          onChange={onChange}
          original={original}
          readOnly={readOnly}
          help={fieldHelp}
          problems={problems}
        />
      );
    case 'oidc':
      return <OidcSettings auth={auth} onChange={onChange} help={fieldHelp} problems={problems} />;
    case 'basic_auth':
      return (
        <TextField
          id={id('realm')}
          label="Realm"
          help={fieldHelp.realm ?? ''}
          problem={problems.realm}
          value={auth.realm}
          placeholder={AUTH_DEFAULTS.realm}
          blank="unset"
          onChange={(value) => onChange(withProp(auth, 'realm', value))}
        />
      );
    case 'hmac':
      return <HmacSettings auth={auth} onChange={onChange} help={fieldHelp} problems={problems} />;
  }
}

type ModeProps<M extends 'jwt' | 'oidc' | 'hmac'> = {
  auth: AuthOf<M>;
  onChange: (auth: AuthConfig) => void;
  help: Partial<Record<AuthField, string>>;
  problems: Problems;
};

function HeaderField({
  auth,
  help,
  problems,
  onChange,
}: {
  auth: AuthOf<'auth_token' | 'jwt' | 'oidc'>;
  help: Partial<Record<AuthField, string>>;
  problems: Problems;
  onChange: (auth: AuthConfig) => void;
}) {
  return (
    <TextField
      id="auth-header"
      label="Header"
      help={help.header ?? ''}
      problem={problems.header}
      value={auth.header}
      placeholder={AUTH_DEFAULTS.header}
      blank="unset"
      onChange={(value) => onChange(withProp(auth, 'header', value))}
    />
  );
}

function IdentityClaimField({
  auth,
  help,
  problems,
  onChange,
}: {
  auth: AuthOf<'jwt' | 'oidc'>;
  help: Partial<Record<AuthField, string>>;
  problems: Problems;
  onChange: (auth: AuthConfig) => void;
}) {
  return (
    <TextField
      id="auth-identity_claim"
      label="Identity claim"
      help={help.identity_claim ?? ''}
      problem={problems.identity_claim}
      value={auth.identity_claim}
      placeholder={AUTH_DEFAULTS.identity_claim}
      blank="unset"
      onChange={(value) => onChange(withProp(auth, 'identity_claim', value))}
    />
  );
}

/** The JWKS URL and its refresh interval, shared by jwt (rs256 from JWKS) and oidc. */
function JwksFields({
  auth,
  onChange,
  help,
  problems,
  blank,
  placeholder,
}: ModeProps<'jwt' | 'oidc'> & { blank: 'unset' | 'empty'; placeholder: string }) {
  return (
    <>
      <TextField
        id="auth-jwks_url"
        label="JWKS URL"
        type="url"
        help={help.jwks_url ?? ''}
        problem={problems.jwks_url}
        value={auth.jwks_url}
        placeholder={placeholder}
        blank={blank}
        onChange={(value) => onChange(withProp(auth, 'jwks_url', value))}
      />
      <NumberField
        id="auth-jwks_refresh_secs"
        label="JWKS refresh (seconds)"
        help={help.jwks_refresh_secs ?? ''}
        problem={problems.jwks_refresh_secs}
        value={auth.jwks_refresh_secs}
        min={1}
        placeholder={String(AUTH_DEFAULTS.jwks_refresh_secs)}
        onChange={(value) => onChange(withProp(auth, 'jwks_refresh_secs', value))}
      />
    </>
  );
}

function JwtSettings({
  auth,
  onChange,
  original,
  help,
  problems,
  readOnly,
}: ModeProps<'jwt'> & { original: AuthConfig | undefined; readOnly: boolean }) {
  const source = jwtKeySource(auth);
  return (
    <>
      <Field id="auth-signing_method" label="Signing method" help={help.signing_method ?? ''}>
        <Select
          value={auth.signing_method}
          onValueChange={(method) =>
            onChange(withSigningMethod(auth, method as JwtSigningMethod, original))
          }
          disabled={readOnly}
        >
          <SelectTrigger id="auth-signing_method" className="w-56 font-mono">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="rs256" className="font-mono">
              rs256 (public key)
            </SelectItem>
            <SelectItem value="hs256" className="font-mono">
              hs256 (shared secret)
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {auth.signing_method === 'hs256' ? (
        <SecretField auth={auth} onChange={onChange} help={help} problems={problems} />
      ) : (
        <>
          <Field
            id="auth-key-source"
            label="Verification key"
            help="A PEM public key, or a JWKS URL whose keys are fetched and refreshed in the background (tokens must carry a matching kid)."
          >
            <Select
              value={source}
              onValueChange={(next) => onChange(withJwtKeySource(auth, next as 'pem' | 'jwks'))}
              disabled={readOnly}
            >
              <SelectTrigger id="auth-key-source" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pem">PEM public key</SelectItem>
                <SelectItem value="jwks">JWKS URL</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {source === 'pem' ? (
            <Field
              id="auth-public_key_pem"
              label="Public key (PEM)"
              help={help.public_key_pem ?? ''}
              problem={problems.public_key_pem}
            >
              <Textarea
                id="auth-public_key_pem"
                rows={4}
                className="font-mono text-xs"
                placeholder="-----BEGIN PUBLIC KEY-----"
                value={auth.public_key_pem ?? ''}
                onChange={(event) => onChange(withProp(auth, 'public_key_pem', event.target.value))}
              />
            </Field>
          ) : (
            <JwksFields
              auth={auth}
              onChange={onChange}
              help={help}
              problems={problems}
              blank="empty"
              placeholder="https://issuer.example/.well-known/jwks.json"
            />
          )}
        </>
      )}
      <HeaderField auth={auth} help={help} problems={problems} onChange={onChange} />
      <IdentityClaimField auth={auth} help={help} problems={problems} onChange={onChange} />
    </>
  );
}

/**
 * The hs256 shared secret. Masked for a role without `apis:write` (ADR-0010):
 * then it is said to be hidden and never rendered as an editable value, so the
 * mask cannot be typed around and saved (the BFF refuses it regardless).
 */
function SecretField({ auth, onChange, help, problems }: ModeProps<'jwt'>) {
  if (auth.secret !== undefined && auth.secret !== null && containsMask(auth.secret)) {
    return (
      <Field id="auth-secret" label="Shared secret" help={help.secret ?? ''}>
        <p id="auth-secret" className="font-mono text-sm text-muted" title={SECRET_MASK}>
          Hidden: your role cannot see secrets.
        </p>
      </Field>
    );
  }
  return (
    <TextField
      id="auth-secret"
      label="Shared secret"
      type="password"
      help={help.secret ?? ''}
      problem={problems.secret}
      value={auth.secret}
      blank="empty"
      onChange={(value) => onChange(withProp(auth, 'secret', value))}
    />
  );
}

function OidcSettings({ auth, onChange, help, problems }: ModeProps<'oidc'>) {
  return (
    <>
      <TextField
        id="auth-issuer_url"
        label="Issuer URL"
        type="url"
        help={help.issuer_url ?? ''}
        problem={problems.issuer_url}
        value={auth.issuer_url}
        placeholder="https://issuer.example"
        blank="empty"
        onChange={(value) => onChange({ ...auth, issuer_url: value ?? '' })}
      />
      <LinesField
        id="auth-audiences"
        label="Audiences"
        help={help.audiences ?? ''}
        problem={problems.audiences}
        value={auth.audiences}
        placeholder="One aud value per line (at least one)"
        onChange={(value) => onChange({ ...auth, audiences: value ?? [] })}
      />
      <JwksFields
        auth={auth}
        onChange={onChange}
        help={help}
        problems={problems}
        blank="unset"
        placeholder="discovered from the issuer"
      />
      <HeaderField auth={auth} help={help} problems={problems} onChange={onChange} />
      <IdentityClaimField auth={auth} help={help} problems={problems} onChange={onChange} />
      <TextField
        id="auth-policy_claim"
        label="Policy claim"
        help={help.policy_claim ?? ''}
        problem={problems.policy_claim}
        value={auth.policy_claim}
        placeholder={AUTH_DEFAULTS.policy_claim}
        blank="unset"
        onChange={(value) => onChange(withProp(auth, 'policy_claim', value))}
      />
      <PolicyMapField auth={auth} onChange={onChange} help={help} problems={problems} />
    </>
  );
}

function PolicyMapField({ auth, onChange, help, problems }: ModeProps<'oidc'>) {
  const parse = (text: string) => {
    const parsed = parsePolicyMap(text);
    return parsed.ok ? parsed.value : undefined;
  };
  const [text, setText] = useSyncedText(auth.policy_map, formatPolicyMap, parse);
  const parsed = parsePolicyMap(text);
  return (
    <Field
      id="auth-policy_map"
      label="Policy map"
      help={help.policy_map ?? ''}
      problem={parsed.ok ? problems.policy_map : parsed.problem}
    >
      <Textarea
        id="auth-policy_map"
        rows={3}
        className="font-mono text-xs"
        placeholder="client_id = policy_id, one per line (optional)"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          const next = parsePolicyMap(event.target.value);
          if (next.ok) onChange(withProp(auth, 'policy_map', next.value));
        }}
      />
    </Field>
  );
}

function HmacSettings({ auth, onChange, help, problems }: ModeProps<'hmac'>) {
  const allowed = auth.allowed_algorithms ?? HMAC_ALGORITHMS;
  const skewOn = auth.allowed_clock_skew_secs !== null;
  return (
    <>
      <Field
        id="auth-allowed_algorithms"
        label="Allowed algorithms"
        help={help.allowed_algorithms ?? ''}
        problem={problems.allowed_algorithms}
      >
        <div id="auth-allowed_algorithms" className="flex flex-wrap gap-4">
          {HMAC_ALGORITHMS.map((algorithm) => (
            <div key={algorithm} className="flex items-center gap-2">
              <input
                type="checkbox"
                id={`auth-alg-${algorithm}`}
                checked={allowed.includes(algorithm)}
                onChange={(event) =>
                  onChange(withHmacAlgorithm(auth, algorithm, event.target.checked))
                }
              />
              <Label htmlFor={`auth-alg-${algorithm}`} className="font-mono text-xs">
                {algorithm}
              </Label>
            </div>
          ))}
        </div>
      </Field>
      <div className="flex flex-col gap-3">
        <Toggle
          id="auth-date-check"
          label="Check the Date header"
          help={help.allowed_clock_skew_secs ?? ''}
          checked={skewOn}
          // Off is an explicit null (g2way: "disabled"), distinct from absent (default).
          onChange={(on) =>
            onChange(withProp(auth, 'allowed_clock_skew_secs', on ? undefined : null))
          }
        />
        {skewOn && (
          <NumberField
            id="auth-allowed_clock_skew_secs"
            label="Allowed clock skew (seconds)"
            help=""
            problem={problems.allowed_clock_skew_secs}
            value={auth.allowed_clock_skew_secs}
            min={1}
            placeholder={String(AUTH_DEFAULTS.allowed_clock_skew_secs)}
            onChange={(value) => onChange(withProp(auth, 'allowed_clock_skew_secs', value))}
          />
        )}
      </div>
    </>
  );
}
