import 'server-only';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { propertyHelp, schemaIntro, variantHelp } from '@/lib/designer/help';
import { CHAIN_SLOTS } from './chain';
import { AUTH_MODES, type AuthMode } from './list';

/**
 * The source of each chain slot's explain panel: which passages of g2way's
 * vendored docs (`contracts/g2way-docs/`, copied verbatim by
 * `npm run sync:g2way`) explain it, and, for slots no doc covers, which
 * rustdoc does.
 *
 * Passages are cut by heading, so a panel shows the part of a doc about the
 * slot, not the whole page. `slot-docs.test.ts` checks that every file and
 * heading named here exists, so a sync that renames one fails the build;
 * the vendored docs are watched as the `docs` area in `contracts/watch.json`.
 *
 * Server-only: it reads files. The markdown is rendered on the server too
 * (`src/components/apis/slot-explain.tsx`).
 */

/** Where the docs live, relative to the project root (`next start` and vitest run there). */
export const DOCS_DIR = join('contracts', 'g2way-docs');

/**
 * A passage of a vendored doc. `heading` names a section by its exact text
 * (any level); absent, the passage is the doc's introduction, between its
 * title and its first heading.
 */
export type DocRef = { file: string; heading?: string; authMode?: AuthMode };

const intro = (file: string, authMode?: AuthMode): DocRef => ({ file, authMode });
const section = (file: string, heading: string, authMode?: AuthMode): DocRef => ({
  file,
  heading,
  authMode,
});

const TELEMETRY = [section('observability.md', 'What the gateway emits')];
const PLUGINS = [intro('plugins.md'), section('plugins.md', 'Semantics')];

/** The doc passages explaining each slot, by slot id. Slots absent here fall back to rustdoc. */
export const SLOT_DOCS: Readonly<Record<string, readonly DocRef[]>> = {
  trace: TELEMETRY,
  metrics: TELEMETRY,
  analytics: TELEMETRY,
  'plugins-pre': PLUGINS,
  'plugins-post': PLUGINS,
  auth: [
    intro('oidc.md', 'oidc'),
    section('oidc.md', 'Token validation', 'oidc'),
    section('oidc.md', 'Responses', 'oidc'),
    intro('hmac.md', 'hmac'),
    section('hmac.md', 'Responses', 'hmac'),
    section('tls.md', 'Enabling mTLS auth on an API', 'mtls'),
  ],
  'rate-limit': [
    intro('endpoint-rate-limits.md'),
    section('endpoint-rate-limits.md', 'Interaction with session limits'),
  ],
  graphql: [
    intro('graphql.md'),
    section('graphql.md', 'Interactions and limits'),
    section('graphql.md', 'Response caching'),
  ],
  'transform-body': [intro('body-transforms.md'), section('body-transforms.md', 'Semantics')],
};

/** The g2way ADRs recording each slot's design, by slot id (paths under `DOCS_DIR`). */
export const SLOT_ADRS: Readonly<Record<string, readonly string[]>> = {
  'plugins-pre': ['adr/0005-wasm-plugins.md'],
  'plugins-post': ['adr/0005-wasm-plugins.md'],
  auth: ['adr/0003-tls-termination-and-mtls.md'],
  graphql: [
    'adr/0004-graphql.md',
    'adr/0010-graphql-udg.md',
    'adr/0011-graphql-federation.md',
    'adr/0012-graphql-response-caching.md',
  ],
  'transform-body': ['adr/0007-body-transforms.md'],
};

/**
 * Schemas whose introduction explains a slot beyond its `ApiDefinition`
 * fields' own rustdoc, by slot id.
 */
const RUSTDOC_SCHEMAS: Readonly<Record<string, readonly string[]>> = {
  cors: ['CorsConfig'],
  'transform-headers': ['HeaderTransforms'],
  mock: ['MockResponse'],
  cache: ['CacheConfig'],
};

type Line = { text: string; level: number | null };

/**
 * The doc's lines, each with its ATX heading level (`## Title` → 2), or null
 * for body lines. Lines inside fenced code blocks are never headings: shell
 * comments (`# 1. A CA…`) and Rust attributes (`#[no_mangle]`) start with `#`.
 */
function lines(markdown: string): Line[] {
  let fence: string | null = null;
  return markdown.split('\n').map((text) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(text)?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = marker[0];
      else if (marker[0] === fence) fence = null;
      return { text, level: null };
    }
    const heading = fence === null ? /^(#{1,6})\s+\S/.exec(text) : null;
    return { text, level: heading ? heading[1].length : null };
  });
}

const headingText = (line: string) => line.replace(/^#{1,6}\s+/, '').trim();

/** Every heading's text, in order: what a {@link DocRef} may name. */
export function headings(markdown: string): string[] {
  return lines(markdown)
    .filter((line) => line.level !== null)
    .map((line) => headingText(line.text));
}

/** The body of the section headed `heading`, up to the next heading of its level or above; null if absent. */
export function extractSection(markdown: string, heading: string): string | null {
  const all = lines(markdown);
  const start = all.findIndex((line) => line.level !== null && headingText(line.text) === heading);
  if (start === -1) return null;
  const level = all[start].level ?? 0;
  const end = all.findIndex((line, i) => i > start && line.level !== null && line.level <= level);
  return all
    .slice(start + 1, end === -1 ? undefined : end)
    .map((line) => line.text)
    .join('\n')
    .trim();
}

/** The introduction: what sits between the title and the first heading after it. */
export function extractIntro(markdown: string): string {
  const all = lines(markdown);
  const title = all.findIndex((line) => line.level === 1);
  const end = all.findIndex((line, i) => i > title && line.level !== null);
  return all
    .slice(title + 1, end === -1 ? undefined : end)
    .map((line) => line.text)
    .join('\n')
    .trim();
}

/** A doc's title: its first heading. */
export function docTitle(markdown: string): string {
  return headings(markdown)[0] ?? '';
}

/**
 * Where a link in a doc may point in the dashboard. Only absolute http(s)
 * URLs survive: relative links (other docs, ADRs, g2way source files) and
 * in-page anchors would resolve against the dashboard's own routes, and a
 * `#…` anchor would collide with the designer's `#chain-`/`#edit-` links.
 * Those render as plain text instead.
 */
export function linkHref(href: string | undefined): string | null {
  return href !== undefined && /^https?:\/\//i.test(href) ? href : null;
}

/** Reads a vendored doc; null when it is missing (a container without them). */
export function readDoc(file: string): string | null {
  try {
    return readFileSync(join(process.cwd(), DOCS_DIR, file), 'utf8');
  } catch {
    return null;
  }
}

/** The markdown a {@link DocRef} names, or null when its file or heading is missing. */
export function passage(ref: DocRef, read: (file: string) => string | null = readDoc) {
  const markdown = read(ref.file);
  if (markdown === null) return null;
  return ref.heading === undefined ? extractIntro(markdown) : extractSection(markdown, ref.heading);
}

/** One passage of a slot's panel, as markdown. */
export type SlotSource = { source: string; markdown: string; authMode?: AuthMode };

/** A slot's panel as markdown, before rendering (see `SlotExplanation` in chain.ts). */
export type SlotDoc = { docs: SlotSource[]; rustdoc: SlotSource[]; adrs: string[] };

function rustdocFor(slotId: string): SlotSource[] {
  const slot = CHAIN_SLOTS.find((s) => s.id === slotId);
  const entries: SlotSource[] = [];
  if (slotId === 'auth') {
    for (const mode of AUTH_MODES) {
      entries.push({
        source: `rustdoc: AuthConfig (${mode})`,
        markdown: variantHelp('AuthConfig', 'mode', mode),
        authMode: mode,
      });
    }
  }
  for (const field of slot?.fields ?? []) {
    entries.push({
      source: `rustdoc: ApiDefinition.${field}`,
      markdown: propertyHelp('ApiDefinition', field),
    });
  }
  for (const schema of RUSTDOC_SCHEMAS[slotId] ?? []) {
    entries.push({ source: `rustdoc: ${schema}`, markdown: schemaIntro(schema) });
  }
  return entries.filter((entry) => entry.markdown !== '');
}

/**
 * Every slot's panel, as markdown: doc passages from {@link SLOT_DOCS}
 * (missing ones skipped, so a container without the docs still renders),
 * the rustdoc fallback, and ADR titles.
 */
export function slotDocs(read: (file: string) => string | null = readDoc): Record<string, SlotDoc> {
  return Object.fromEntries(
    CHAIN_SLOTS.map((slot) => {
      const docs = (SLOT_DOCS[slot.id] ?? []).flatMap((ref): SlotSource[] => {
        const markdown = passage(ref, read);
        if (markdown === null || markdown === '') return [];
        const source = ref.heading === undefined ? ref.file : `${ref.file} § ${ref.heading}`;
        return [{ source, markdown, authMode: ref.authMode }];
      });
      const adrs = (SLOT_ADRS[slot.id] ?? []).flatMap((file) => {
        const markdown = read(file);
        return markdown === null ? [] : [docTitle(markdown)];
      });
      return [slot.id, { docs, rustdoc: rustdocFor(slot.id), adrs }];
    }),
  );
}
