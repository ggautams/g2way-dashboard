import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EDITOR_SLOTS, FORWARDER_ID } from '@/lib/apis/chain';

// No component renderer in this repo, so these guard the form at the source.
const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), 'utf8');

describe('ApiForm', () => {
  const source = read('api-form.tsx');

  it('gives every EDITOR_SLOTS slot a section anchored with editorAnchor', () => {
    for (const slot of EDITOR_SLOTS) {
      const arg = slot === FORWARDER_ID ? 'FORWARDER_ID' : `'${slot}'`;
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

  it('imports nothing server-only (it is a client component)', () => {
    expect(source.startsWith("'use client';")).toBe(true);
    expect(source).not.toMatch(/field-help|designer\/help|server-client|lib\/g2\//);
  });
});

describe('RuleList', () => {
  const source = read('rule-list.tsx');
  const fields = read('rule-fields.tsx');

  it('keeps order (first match wins) and shows empty methods as every method', () => {
    expect(source).toContain('moveBy(rules, index, by)');
    expect(source).toContain('describeMethods(value)');
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
