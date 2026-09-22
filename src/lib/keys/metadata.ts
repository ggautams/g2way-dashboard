/**
 * The dashboard's own description of a key (ADR-0009 §7): a label, an owner
 * and notes, kept in the dashboard database by key hash because g2way lists
 * hashes only. Universal: the form parsing runs in server actions, the limits
 * are shown in the browser.
 *
 * These are dashboard records, not gateway writes: saving one needs no
 * reload and is never staged.
 */

/** A key's metadata fields. `null` is "not set". */
export type KeyMetadataFields = {
  label: string | null;
  /** Free text: a team, customer or service, not necessarily a dashboard account. */
  owner: string | null;
  notes: string | null;
};

export const KEY_METADATA_LIMITS: Readonly<Record<keyof KeyMetadataFields, number>> = {
  label: 120,
  owner: 120,
  notes: 2000,
};

export const EMPTY_KEY_METADATA: KeyMetadataFields = { label: null, owner: null, notes: null };

const FIELD_NAMES = ['label', 'owner', 'notes'] as const;

/** True when no field is set. */
export function isEmptyKeyMetadata(fields: KeyMetadataFields): boolean {
  return FIELD_NAMES.every((name) => fields[name] === null);
}

export type ParsedKeyMetadata =
  { ok: true; value: KeyMetadataFields } | { ok: false; error: string };

/**
 * Normalises raw field values: trimmed (notes keep their inner line breaks),
 * blank becomes `null`, and anything over its limit is refused rather than
 * silently cut.
 */
export function parseKeyMetadata(
  input: Partial<Record<keyof KeyMetadataFields, unknown>>,
): ParsedKeyMetadata {
  const value: KeyMetadataFields = { ...EMPTY_KEY_METADATA };
  for (const name of FIELD_NAMES) {
    const raw = input[name];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') return { ok: false, error: `${name} must be text` };
    const text = name === 'notes' ? raw.replace(/\r\n/g, '\n').trim() : raw.trim();
    if (name !== 'notes' && /[\n\r]/.test(text)) {
      return { ok: false, error: `${name} must be one line` };
    }
    if (text.length > KEY_METADATA_LIMITS[name]) {
      return {
        ok: false,
        error: `${name} is ${text.length} characters; the limit is ${KEY_METADATA_LIMITS[name]}`,
      };
    }
    value[name] = text === '' ? null : text;
  }
  return { ok: true, value };
}

/** {@link parseKeyMetadata} over a submitted form's `label`, `owner` and `notes`. */
export function parseKeyMetadataForm(form: FormData): ParsedKeyMetadata {
  const read = (name: string) => {
    const value = form.get(name);
    return typeof value === 'string' ? value : null;
  };
  return parseKeyMetadata({ label: read('label'), owner: read('owner'), notes: read('notes') });
}

/** What the metadata form shows after a submit. */
export type KeyMetadataFormState = {
  error: string | null;
  notice?: string;
  /** The fields as stored after a successful save. */
  saved?: KeyMetadataFields;
};

export const INITIAL_KEY_METADATA_FORM_STATE: KeyMetadataFormState = { error: null };
