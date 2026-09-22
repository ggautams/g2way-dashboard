import 'server-only';

import { propertyHelp, variantHelp } from '@/lib/designer/help';
import { AUTH_FIELDS, type AuthField, type AuthHelp } from './auth';
import { FORM_FIELDS, type ApiHelp, type FormField } from './draft';
import { AUTH_MODES } from './list';
import { RULE_HELP_KEYS, type RuleHelp } from './rules';

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

/** Where each rule setting's rustdoc lives: the schema that declares it. */
const RULE_HELP_SCHEMA: Record<keyof RuleHelp, string> = {
  pattern: 'PathRule',
  methods: 'PathRule',
  rewrite: 'UrlRewriteRule',
  status: 'MockResponse',
  headers: 'MockResponse',
  body: 'MockResponse',
  requests: 'RateLimit',
  per_seconds: 'RateLimit',
};

/** The path-rule editors' help: each rule setting's description. */
export function ruleHelp(): RuleHelp {
  return Object.fromEntries(
    RULE_HELP_KEYS.map((key) => [key, propertyHelp(RULE_HELP_SCHEMA[key], key)]),
  ) as RuleHelp;
}

/** Everything the API form's help text reads, gathered on the server. */
export function apiHelp(): ApiHelp {
  return { fields: fieldHelp(), auth: authHelp(), rules: ruleHelp() };
}
