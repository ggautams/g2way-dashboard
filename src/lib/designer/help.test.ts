import { describe, expect, it } from 'vitest';
import { FORM_FIELDS } from '@/lib/apis/draft';
import { AUTH_FIELDS } from '@/lib/apis/auth';
import { authHelp, fieldHelp, ruleHelp, transformHelp } from '@/lib/apis/field-help';
import { AUTH_MODES } from '@/lib/apis/list';
import { accessFieldHelp } from './access-help';
import { firstParagraph, propertyHelp, schemaHelp } from './help';

describe('fieldHelp', () => {
  it('has g2way’s description for every API form field', () => {
    const help = fieldHelp();
    expect(Object.keys(help).sort()).toEqual([...FORM_FIELDS].sort());
    expect(help.listen_path).toMatch(/begin with/);
  });
});

describe('ruleHelp', () => {
  it('has g2way’s description for every path-rule setting', () => {
    const help = ruleHelp();
    for (const [key, text] of Object.entries(help)) expect(text, key).not.toBe('');
    expect(help.methods).toMatch(/Empty = every method/);
    expect(help.rewrite).toMatch(/start with/);
  });
});

describe('transformHelp', () => {
  it('has g2way’s description for every transform and CORS setting', () => {
    const help = transformHelp();
    for (const [key, text] of Object.entries(help)) expect(text, key).not.toBe('');
    expect(help.headers).toMatch(/remove. runs before .add/);
    expect(help.headers).not.toMatch(/Example|```/);
    expect(help.allowed_origins).toMatch(/cannot be combined/);
    expect(help.max_response_body_bytes).toMatch(/502/);
  });
});

describe('propertyHelp', () => {
  it('reads an optional field’s description off its non-null oneOf branch', () => {
    expect(propertyHelp('Policy', 'rate')).toMatch(/None. means unlimited/);
    expect(propertyHelp('Policy', 'name')).toMatch(/Human-readable/);
    expect(propertyHelp('Policy', 'no_such_field')).toBe('');
  });

  it('keeps the first paragraph, unwrapped, with rustdoc links as text', () => {
    expect(
      firstParagraph(
        'Base URL, see [`Self::target_url`](x)\nand [`EndpointRateLimit`].\n\nMore detail.',
      ),
    ).toBe('Base URL, see Self::target_url and EndpointRateLimit.');
  });
});

describe('schemaHelp', () => {
  it('keeps every paragraph of a schema description, unwrapped', () => {
    const help = schemaHelp('ApiAccess');
    expect(help).toMatch(/^Access granted to a single API\. An entry/);
    expect(help).toMatch(/grants unrestricted access\.$/);
    expect(help).not.toContain('\n');
    expect(schemaHelp('NoSuchSchema')).toBe('');
  });
});

describe('accessFieldHelp', () => {
  it('has g2way’s description for every access matrix field', () => {
    const help = accessFieldHelp('Policy');
    for (const [key, text] of Object.entries(help)) expect(text, key).not.toBe('');
    expect(help.access).toMatch(/every API/);
    expect(help.allowed_types).toMatch(/allow list wins/);
    expect(help.max_query_depth).toMatch(/inherits/);
    expect(accessFieldHelp('KeySession').access).toMatch(/every API/);
  });
});

describe('authHelp', () => {
  it('has g2way’s description for every auth mode and setting', () => {
    const help = authHelp();
    for (const mode of AUTH_MODES) {
      expect(help[mode].summary, mode).not.toBe('');
      for (const field of AUTH_FIELDS[mode]) expect(help[mode].fields[field], field).not.toBe('');
    }
    expect(help.oidc.fields.audiences).toMatch(/non-empty/);
    expect(help.auth_token.summary).toMatch(/KeySession/);
    expect(help.auth_token.summary).not.toMatch(/crate::/);
  });
});
