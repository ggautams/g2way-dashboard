import 'server-only';

import { propertyHelp, variantHelp } from '@/lib/designer/help';
import { AUTH_FIELDS, type AuthField, type AuthHelp } from './auth';
import { FORM_FIELDS, type ApiHelp, type FormField } from './draft';
import { AUTH_MODES } from './list';

/** The API designer's help text for each form field (g2way's rustdoc, first paragraph). */
export function fieldHelp(): Record<FormField, string> {
  return Object.fromEntries(
    FORM_FIELDS.map((field) => [field, propertyHelp('ApiDefinition', field)]),
  ) as Record<FormField, string>;
}

/** Each auth mode's own description, and each of its settings'. */
export function authHelp(): AuthHelp {
  return Object.fromEntries(
    AUTH_MODES.map((mode) => {
      const fields: readonly AuthField[] = AUTH_FIELDS[mode];
      return [
        mode,
        {
          summary: variantHelp('AuthConfig', 'mode', mode),
          fields: Object.fromEntries(
            fields.map((field) => [field, variantHelp('AuthConfig', 'mode', mode, field)]),
          ),
        },
      ];
    }),
  ) as AuthHelp;
}

/** Everything the API form's help text reads, gathered on the server. */
export function apiHelp(): ApiHelp {
  return { fields: fieldHelp(), auth: authHelp() };
}
