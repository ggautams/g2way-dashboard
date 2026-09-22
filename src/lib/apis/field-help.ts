import 'server-only';

import spec from '../../../contracts/openapi.json';
import { FORM_FIELDS, type FormField } from './draft';

/**
 * The designer's help text for each form field: g2way's own rustdoc, as the
 * OpenAPI document carries it, cut to its first paragraph. Read on the server
 * and passed down as props, so the spec never ships in the client bundle.
 */
export function fieldHelp(): Record<FormField, string> {
  const properties = spec.components.schemas.ApiDefinition.properties as Record<
    string,
    { description?: string }
  >;
  return Object.fromEntries(
    FORM_FIELDS.map((field) => [field, firstParagraph(properties[field]?.description ?? '')]),
  ) as Record<FormField, string>;
}

/** The first paragraph, unwrapped, with rustdoc links reduced to their text. */
export function firstParagraph(description: string): string {
  return (description.split(/\n\s*\n/)[0] ?? '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\[`?([^\]`]+)`?\]\([^)]*\)/g, '$1')
    .replace(/\[`([^\]`]+)`\]/g, '$1')
    .trim();
}
