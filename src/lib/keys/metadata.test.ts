import { describe, expect, it } from 'vitest';
import {
  KEY_METADATA_LIMITS,
  isEmptyKeyMetadata,
  parseKeyMetadata,
  parseKeyMetadataForm,
} from './metadata';

describe('parseKeyMetadata', () => {
  it('trims, and turns blanks into "not set"', () => {
    expect(parseKeyMetadata({ label: '  Checkout ', owner: '   ', notes: '\n a\r\nb \n' })).toEqual(
      {
        ok: true,
        value: { label: 'Checkout', owner: null, notes: 'a\nb' },
      },
    );
    expect(parseKeyMetadata({})).toEqual({
      ok: true,
      value: { label: null, owner: null, notes: null },
    });
  });

  it('refuses rather than cuts: over-long, multi-line or non-text values', () => {
    const long = 'x'.repeat(KEY_METADATA_LIMITS.label + 1);
    expect(parseKeyMetadata({ label: long })).toEqual({
      ok: false,
      error: `label is ${long.length} characters; the limit is ${KEY_METADATA_LIMITS.label}`,
    });
    expect(parseKeyMetadata({ owner: 'a\nb' })).toEqual({
      ok: false,
      error: 'owner must be one line',
    });
    expect(parseKeyMetadata({ notes: 3 })).toEqual({ ok: false, error: 'notes must be text' });
  });

  it('reads a form', () => {
    const form = new FormData();
    form.set('label', 'L');
    form.set('owner', 'O');
    const parsed = parseKeyMetadataForm(form);
    expect(parsed).toEqual({ ok: true, value: { label: 'L', owner: 'O', notes: null } });
    expect(parsed.ok && isEmptyKeyMetadata(parsed.value)).toBe(false);
    expect(isEmptyKeyMetadata({ label: null, owner: null, notes: null })).toBe(true);
  });
});
