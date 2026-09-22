import { describe, expect, it } from 'vitest';
import { FORM_FIELDS } from './draft';
import { fieldHelp, firstParagraph } from './field-help';

describe('fieldHelp', () => {
  it('has g2way’s description for every form field', () => {
    const help = fieldHelp();
    expect(Object.keys(help).sort()).toEqual([...FORM_FIELDS].sort());
    expect(help.listen_path).toMatch(/begin with/);
  });

  it('keeps the first paragraph, unwrapped, with rustdoc links as text', () => {
    expect(
      firstParagraph(
        'Base URL, see [`Self::target_url`](x)\nand [`EndpointRateLimit`].\n\nMore detail.',
      ),
    ).toBe('Base URL, see Self::target_url and EndpointRateLimit.');
  });
});
