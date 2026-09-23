import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DISPATCHER_ID, EDITOR_SLOTS, FORWARDER_ID, VERSION_EDITOR_SLOTS } from '@/lib/apis/chain';

// No component renderer in this repo, so these guard the form at the source.
const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), 'utf8');

describe('ApiForm', () => {
  const source = read('api-form.tsx');

  it('gives every EDITOR_SLOTS slot a section anchored with editorAnchor', () => {
    for (const slot of EDITOR_SLOTS) {
      const arg =
        slot === FORWARDER_ID
          ? 'FORWARDER_ID'
          : slot === DISPATCHER_ID
            ? 'DISPATCHER_ID'
            : `'${slot}'`;
      expect(source, slot).toContain(`<Section id={editorAnchor(${arg})}`);
    }
    expect(source).not.toMatch(/id=\{?[`'"]edit-/);
  });

  it('edits auth through the per-mode settings, not a pointer to the raw view', () => {
    expect(source).toContain('<AuthSettings');
    expect(source).toContain('effectiveAuth(draft)');
    expect(source).not.toMatch(/set them in the\s+raw definition/);
  });

  it('edits the size limit, IP lists and method override', () => {
    for (const field of ['max_request_body_bytes', 'allow_ips', 'block_ips', 'transform_method']) {
      expect(source, field).toContain(`set('${field}'`);
    }
    expect(source).toContain('TRANSFORM_METHODS.map(');
  });

  it('edits all six path-rule lists through the shared RuleList', () => {
    for (const list of [
      'block_paths',
      'allow_paths',
      'ignore_auth_paths',
      'endpoint_rate_limits',
      'mock_responses',
      'url_rewrites',
    ]) {
      expect(source, list).toContain(`{...rules('${list}')}`);
    }
    expect(source).toContain('extra={RateExtra}');
    expect(source).toContain('extra={MockExtra}');
    expect(source).toContain('extra={RewriteExtra}');
    expect(source).toContain('problemsOf(problems, list)');
  });

  it('edits CORS, header and body transforms through their editors', () => {
    expect(source).toContain('<CorsEditor');
    expect(source).toContain('<HeaderTransformsEditor');
    expect(source).toContain('<BodyTransformsEditor');
    for (const field of ['cors', 'transform_headers', 'transform_body']) {
      expect(source, field).toContain(`set('${field}'`);
    }
    expect(source).toMatch(/Content-Type wins over a header\s+transform/);
  });

  it('imports nothing server-only (it is a client component)', () => {
    expect(source.startsWith("'use client';")).toBe(true);
    expect(source).not.toMatch(/field-help|designer\/help|server-client|lib\/g2\//);
  });
});

describe('VersioningEditor', () => {
  const source = read('versioning-editor.tsx');

  it('sits in the form’s Versioning section, the dispatcher’s editor', () => {
    const form = read('api-form.tsx');
    expect(form).toContain('<Section id={editorAnchor(DISPATCHER_ID)} title="Versioning">');
    expect(form).toContain('<VersioningEditor');
  });

  it('anchors each version card and each overridable slot per version', () => {
    expect(source).toContain('id={editorAnchor(DISPATCHER_ID, name)}');
    for (const slot of VERSION_EDITOR_SLOTS) {
      const arg = slot === FORWARDER_ID ? 'FORWARDER_ID' : `'${slot}'`;
      expect(source, slot).toContain(`<Part id={editorAnchor(${arg}, name)}`);
    }
  });

  it('reuses the base editors with the base’s value as inherited', () => {
    for (const list of [
      'block_paths',
      'allow_paths',
      'ignore_auth_paths',
      'endpoint_rate_limits',
      'mock_responses',
      'url_rewrites',
    ]) {
      expect(source, list).toContain(`{...rules('${list}')}`);
    }
    expect(source).toContain('inherited: (draft[list] ?? null)');
    expect(source).toContain('inherited={draft.transform_headers ?? null}');
    expect(source).toContain('inherited={draft.transform_body ?? null}');
    expect(source).toContain('problemsOf(problems, `${prefix}.${list}`)');
    expect(source).toContain('prefix={`${prefix}.transform_headers`}');
    expect(source).toContain('prefix={`${prefix}.transform_body`}');
  });

  it('edits only through the pure helpers, leaving deferred overrides untouched', () => {
    for (const helper of [
      'withVersioning(',
      'withSetting(',
      'addVersion(',
      'removeVersion(',
      'renameVersion(',
      'withOverride(',
      'deferredOverrides(',
    ]) {
      expect(source, helper).toContain(helper);
    }
    expect(source).toMatch(/edit in JSON\/YAML/);
  });

  it('says what every version shares, and what no default means', () => {
    expect(source).toContain('Inherited from base, shared by all versions');
    expect(source).toContain('SHARED_FIELDS.map(');
    expect(source).toMatch(/a version is required \(403 otherwise\)/);
  });

  it('imports nothing server-only', () => {
    expect(source.startsWith("'use client';")).toBe(true);
    expect(source).not.toMatch(/field-help|designer\/help|server-client|lib\/g2\//);
  });
});

describe('RuleList', () => {
  const source = read('rule-list.tsx');
  const fields = read('rule-fields.tsx');

  it('keeps order (first match wins) and shows empty methods as every method', () => {
    expect(source).toContain('moveBy(rules, index, by)');
    expect(source).toContain('describeMethods(value, none)');
    expect(source).toContain('TRANSFORM_METHODS');
  });

  it('has an inherited-from-base state for version overrides: absent inherits, [] clears', () => {
    expect(source).toContain('const override = inherited !== undefined');
    expect(source).toMatch(/Inherited from base/);
    expect(source).toContain('next.length === 0 && !override ? undefined : next');
    expect(source).toMatch(/Cleared for this version/);
  });

  it('renders kind settings with module-level components, so inputs keep focus', () => {
    for (const name of ['RewriteExtra', 'MockExtra', 'RateExtra']) {
      expect(fields).toContain(`export const ${name}: RuleExtra<`);
    }
    expect(fields).toContain('<LimitInput');
  });

  it('imports nothing server-only', () => {
    for (const text of [source, fields]) {
      expect(text.startsWith("'use client';")).toBe(true);
      expect(text).not.toMatch(/field-help|designer\/help|server-client|lib\/g2\//);
    }
  });
});

describe('AuthSettings', () => {
  const source = read('auth-settings.tsx');

  it('covers every auth mode', () => {
    for (const mode of ['keyless', 'mtls', 'auth_token', 'jwt', 'oidc', 'basic_auth', 'hmac']) {
      expect(source, mode).toContain(`case '${mode}':`);
    }
  });

  it('edits settings in place through the pure helpers', () => {
    for (const helper of [
      'withProp(',
      'withSigningMethod(',
      'withJwtKeySource(',
      'withHmacAlgorithm(',
    ]) {
      expect(source).toContain(helper);
    }
  });

  it('never renders a masked secret as an editable value (ADR-0010)', () => {
    expect(source).toContain('containsMask(auth.secret)');
    expect(source).toMatch(/Hidden: your role cannot see secrets/);
    expect(source).toContain('type="password"');
  });

  it('keeps HMAC’s disabled Date check (null) distinct from the default (absent)', () => {
    expect(source).toContain("withProp(auth, 'allowed_clock_skew_secs', on ? undefined : null)");
  });

  it('imports nothing server-only', () => {
    expect(source.startsWith("'use client';")).toBe(true);
    expect(source).not.toMatch(/field-help|designer\/help|server-client|lib\/g2\//);
  });
});

describe('transform editors', () => {
  const source = read('transform-editors.tsx');
  const fields = read('rule-fields.tsx');

  it('never renders a masked header value as text, and can drop it (ADR-0010)', () => {
    expect(source).toContain('useMemo(() => splitMasked(value), [value])');
    expect(source).toContain('mergeMasked(parsed.value, value, hidden)');
    expect(source).toMatch(/Hidden: your role cannot see this value/);
    expect(source).toContain('withoutHeader(value, name)');
  });

  it('has an inherited-from-base state for 2d’s block overrides', () => {
    expect(source).toContain('export function InheritedBlock(');
    for (const editor of ['HeaderTransformsEditor', 'BodyTransformsEditor']) {
      expect(source, editor).toMatch(
        new RegExp(`export function ${editor}\\([\\s\\S]*?inherited\\?:`),
      );
    }
    expect(source).toContain('withHeaderTransform(value, direction, next, override)');
    expect(source).toContain('withBodyRules(value, direction, rules, override)');
  });

  it('edits body rules through the shared RuleList with a module-level extra', () => {
    expect(source).toContain('<RuleList<BodyTransformRule>');
    expect(source).toContain('extra={BodyExtra}');
    expect(source).toContain('problemsOf(problems, `${prefix}.${direction}`)');
    expect(fields).toContain('export const BodyExtra: RuleExtra<BodyTransformRule>');
  });

  it('shows CORS’s absent method list as g2way’s default, not every method', () => {
    expect(source).toContain('none={`${CORS_DEFAULT_METHODS.join');
  });

  it('imports nothing server-only', () => {
    expect(source.startsWith("'use client';")).toBe(true);
    expect(source).not.toMatch(/field-help|designer\/help|server-client|lib\/g2\//);
  });
});
