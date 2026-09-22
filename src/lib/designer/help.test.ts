import { describe, expect, it } from 'vitest';
import { FORM_FIELDS } from '@/lib/apis/draft';
import { fieldHelp } from '@/lib/apis/field-help';
import { accessFieldHelp } from './access-help';
import { firstParagraph, propertyHelp, schemaHelp } from './help';

describe('fieldHelp', () => {
  it('has g2way’s description for every API form field', () => {
    const help = fieldHelp();
    expect(Object.keys(help).sort()).toEqual([...FORM_FIELDS].sort());
    expect(help.listen_path).toMatch(/begin with/);
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
