import 'server-only';

import { propertyHelp, schemaIntro, variantHelp } from '@/lib/designer/help';
import { AUTH_FIELDS, type AuthField, type AuthHelp } from './auth';
import { FORM_FIELDS, type ApiHelp, type FormField } from './draft';
import { AUTH_MODES } from './list';
import { RULE_HELP_KEYS, type RuleHelp } from './rules';
import { TRANSFORM_HELP_KEYS, type TransformHelp } from './transforms';

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
  template: 'BodyTransformRule',
  content_type: 'BodyTransformRule',
};

/** The path-rule editors' help: each rule setting's description. */
export function ruleHelp(): RuleHelp {
  return Object.fromEntries(
    RULE_HELP_KEYS.map((key) => [key, propertyHelp(RULE_HELP_SCHEMA[key], key)]),
  ) as RuleHelp;
}

/** Where each transform and CORS help text lives: a schema's introduction, or one property. */
const TRANSFORM_HELP_SOURCE: Record<keyof TransformHelp, readonly [string, string?]> = {
  headers: ['HeaderTransforms'],
  headers_request: ['HeaderTransforms', 'request'],
  headers_response: ['HeaderTransforms', 'response'],
  add: ['HeaderTransform', 'add'],
  remove: ['HeaderTransform', 'remove'],
  body: ['BodyTransforms'],
  body_rule: ['BodyTransformRule'],
  body_request: ['BodyTransforms', 'request'],
  body_response: ['BodyTransforms', 'response'],
  max_response_body_bytes: ['BodyTransforms', 'max_response_body_bytes'],
  cors: ['CorsConfig'],
  allowed_origins: ['CorsConfig', 'allowed_origins'],
  allowed_methods: ['CorsConfig', 'allowed_methods'],
  allowed_headers: ['CorsConfig', 'allowed_headers'],
  exposed_headers: ['CorsConfig', 'exposed_headers'],
  allow_credentials: ['CorsConfig', 'allow_credentials'],
  max_age_secs: ['CorsConfig', 'max_age_secs'],
  options_passthrough: ['CorsConfig', 'options_passthrough'],
};

/** The header, body and CORS editors' help. `headers` also says remove runs before add. */
export function transformHelp(): TransformHelp {
  const help = Object.fromEntries(
    TRANSFORM_HELP_KEYS.map((key) => {
      const [schema, property] = TRANSFORM_HELP_SOURCE[key];
      return [key, property === undefined ? schemaIntro(schema) : propertyHelp(schema, property)];
    }),
  ) as TransformHelp;
  help.headers = `${help.headers} ${schemaIntro('HeaderTransform')}`.trim();
  return help;
}

/** Everything the API form's help text reads, gathered on the server. */
export function apiHelp(): ApiHelp {
  return { fields: fieldHelp(), auth: authHelp(), rules: ruleHelp(), transforms: transformHelp() };
}
