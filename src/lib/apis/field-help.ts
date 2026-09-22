import 'server-only';

import { propertyHelp } from '@/lib/designer/help';
import { FORM_FIELDS, type FormField } from './draft';

/** The API designer's help text for each form field (g2way's rustdoc, first paragraph). */
export function fieldHelp(): Record<FormField, string> {
  return Object.fromEntries(
    FORM_FIELDS.map((field) => [field, propertyHelp('ApiDefinition', field)]),
  ) as Record<FormField, string>;
}
