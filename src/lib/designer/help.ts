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

/**
 * A schema's introduction: its paragraphs up to the first rustdoc heading
 * (`# Example`), each unwrapped like {@link firstParagraph}, joined into one.
 */
export function schemaIntro(schema: string): string {
  const schemas = spec.components.schemas as Record<string, { description?: string }>;
  const paragraphs = (schemas[schema]?.description ?? '').split(/\n\s*\n/);
  const heading = paragraphs.findIndex((paragraph) => paragraph.trimStart().startsWith('#'));
  return paragraphs
    .slice(0, heading === -1 ? undefined : heading)
    .map(firstParagraph)
    .filter((paragraph) => paragraph !== '')
    .join(' ');
}

type VariantSchema = {
  description?: string;
  properties?: Record<string, PropertySchema & { enum?: string[] }>;
};

function variant(schema: string, tag: string, value: string): VariantSchema | undefined {
  const schemas = spec.components.schemas as unknown as Record<string, { oneOf?: VariantSchema[] }>;
  return schemas[schema]?.oneOf?.find((branch) => branch.properties?.[tag]?.enum?.includes(value));
}

/**
 * For a tagged union (`AuthConfig`, tagged by `mode`): the first paragraph of
 * the `value` branch's own description, or of its `property` when one is named.
 */
export function variantHelp(schema: string, tag: string, value: string, property?: string): string {
  const branch = variant(schema, tag, value);
  if (property === undefined) return firstParagraph(branch?.description ?? '');
  const node = branch?.properties?.[property];
  return firstParagraph(
    node?.description ?? node?.oneOf?.find((b) => b.description)?.description ?? '',
  );
}
