import 'server-only';

import spec from '../../../contracts/openapi.json';

/**
 * Help text for designer fields: g2way's own rustdoc, as the OpenAPI document
 * carries it, cut to its first paragraph. Read on the server and passed down as
 * props, so the spec never ships in the client bundle.
 */

type PropertySchema = { description?: string; oneOf?: { description?: string }[] };

/**
 * The description of `schema.property`. utoipa puts an `Option<T>` field's
 * description on the non-null `oneOf` branch rather than on the property, so
 * that is read too.
 */
export function propertyHelp(schema: string, property: string): string {
  const schemas = spec.components.schemas as Record<
    string,
    { properties?: Record<string, PropertySchema> }
  >;
  const node = schemas[schema]?.properties?.[property];
  const description =
    node?.description ?? node?.oneOf?.find((branch) => branch.description)?.description ?? '';
  return firstParagraph(description);
}

/** The first paragraph, unwrapped, with rustdoc links reduced to their text. */
export function firstParagraph(description: string): string {
  return (description.split(/\n\s*\n/)[0] ?? '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\[`?([^\]`]+)`?\]\([^)]*\)/g, '$1')
    .replace(/\[`([^\]`]+)`\]/g, '$1')
    .trim();
}

/**
 * A schema's own description, every paragraph, each unwrapped like
 * {@link firstParagraph}, joined into one. For types whose first paragraph is
 * only a title (`ApiAccess`: "Access granted to a single API.").
 */
export function schemaHelp(schema: string): string {
  const schemas = spec.components.schemas as Record<string, { description?: string }>;
  return (schemas[schema]?.description ?? '')
    .split(/\n\s*\n/)
    .map(firstParagraph)
    .filter((paragraph) => paragraph !== '' && !paragraph.startsWith('#'))
    .join(' ');
}
