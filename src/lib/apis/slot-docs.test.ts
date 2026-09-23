import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHAIN_SLOTS } from './chain';
import {
  DOCS_DIR,
  SLOT_ADRS,
  SLOT_DOCS,
  docTitle,
  extractIntro,
  extractSection,
  headings,
  linkHref,
  passage,
  slotDocs,
} from './slot-docs';

const ROOT = resolve(import.meta.dirname, '../../..');
const docPath = (file: string) => join(ROOT, DOCS_DIR, file);
const refs = Object.entries(SLOT_DOCS).flatMap(([slot, list]) =>
  list.map((ref) => [slot, ref.file, ref.heading ?? '(intro)', ref] as const),
);
const adrs = Object.entries(SLOT_ADRS).flatMap(([slot, list]) =>
  list.map((file) => [slot, file] as const),
);
const slotIds = CHAIN_SLOTS.map((slot) => slot.id);

describe('SLOT_DOCS and SLOT_ADRS', () => {
  it('name real chain slots only', () => {
    for (const id of [...Object.keys(SLOT_DOCS), ...Object.keys(SLOT_ADRS)]) {
      expect(slotIds).toContain(id);
    }
  });

  // A sync that renames a doc or one of these headings fails here.
  it.each(refs)('%s: %s § %s exists in contracts/g2way-docs/ and is not empty', (...args) => {
    const ref = args[3];
    expect(existsSync(docPath(ref.file))).toBe(true);
    const markdown = readFileSync(docPath(ref.file), 'utf8');
    if (ref.heading !== undefined) expect(headings(markdown)).toContain(ref.heading);
    expect(passage(ref)).toBeTruthy();
  });

  it.each(adrs)('%s: %s exists and is an ADR', (_, file) => {
    expect(existsSync(docPath(file))).toBe(true);
    expect(docTitle(readFileSync(docPath(file), 'utf8'))).toMatch(/^ADR-\d{4}: /);
  });

  it('only use docs the drift check watches, and the docs area names this surface', () => {
    const watch = JSON.parse(readFileSync(join(ROOT, 'contracts/watch.json'), 'utf8')) as {
      areas: { id: string; paths: string[]; surfaces: string[] }[];
    };
    const area = watch.areas.find((a) => a.id === 'docs');
    expect(area).toBeDefined();
    const watched = (file: string) =>
      area?.paths.some((path) => `docs/${file}` === path || `docs/${file}`.startsWith(`${path}/`));
    for (const file of [...refs.map((r) => r[1]), ...adrs.map((a) => a[1])]) {
      expect(watched(file), file).toBe(true);
    }
    expect(area?.surfaces.join(' ')).toContain('src/lib/apis/slot-docs.ts');
  });
});

const DOC = [
  '# Title',
  '',
  'Intro text.',
  '',
  '## Configuration',
  '',
  '```sh',
  '# not a heading',
  '```',
  '',
  '### Semantics',
  '',
  '- a rule',
  '',
  '## Limits',
  '',
  'Last.',
].join('\n');

describe('headings and extraction', () => {
  it('lists headings, skipping `#` lines inside fenced code', () => {
    expect(headings(DOC)).toEqual(['Title', 'Configuration', 'Semantics', 'Limits']);
    expect(docTitle(DOC)).toBe('Title');
  });

  it('cuts a section up to the next heading of its level, keeping deeper ones', () => {
    expect(extractSection(DOC, 'Configuration')).toBe(
      ['```sh', '# not a heading', '```', '', '### Semantics', '', '- a rule'].join('\n'),
    );
    expect(extractSection(DOC, 'Semantics')).toBe('- a rule');
    expect(extractSection(DOC, 'Limits')).toBe('Last.');
    expect(extractSection(DOC, 'Missing')).toBeNull();
  });

  it('takes the introduction between the title and the first heading', () => {
    expect(extractIntro(DOC)).toBe('Intro text.');
  });
});

describe('linkHref', () => {
  it('keeps absolute http(s) links only', () => {
    expect(linkHref('https://docs.rs/minijinja')).toBe('https://docs.rs/minijinja');
    expect(linkHref('http://example.com')).toBe('http://example.com');
  });

  it('drops relative links and anchors, which would break or hijack designer links', () => {
    expect(linkHref('adr/0007-body-transforms.md')).toBeNull();
    expect(linkHref('../README.md')).toBeNull();
    expect(linkHref('#response-caching')).toBeNull();
    expect(linkHref('javascript:alert(1)')).toBeNull();
    expect(linkHref(undefined)).toBeNull();
  });
});

describe('slotDocs', () => {
  it('gives every slot a panel from the vendored docs', () => {
    const docs = slotDocs();
    expect(Object.keys(docs)).toEqual(slotIds);
    for (const [id, list] of Object.entries(SLOT_DOCS)) {
      expect(docs[id].docs).toHaveLength(list.length);
    }
    expect(docs['transform-body'].docs.map((d) => d.source)).toEqual([
      'body-transforms.md',
      'body-transforms.md § Semantics',
    ]);
    expect(docs.graphql.adrs[0]).toMatch(/^ADR-0004: /);
  });

  it('tags the auth slot’s docs and rustdoc by mode', () => {
    const auth = slotDocs().auth;
    expect(new Set(auth.docs.map((d) => d.authMode))).toEqual(new Set(['oidc', 'hmac', 'mtls']));
    expect(auth.rustdoc.some((d) => d.authMode === 'jwt')).toBe(true);
  });

  it('falls back to rustdoc for slots no doc covers', () => {
    const cors = slotDocs().cors;
    expect(cors.docs).toEqual([]);
    expect(cors.rustdoc.map((d) => d.source)).toEqual([
      'rustdoc: ApiDefinition.cors',
      'rustdoc: CorsConfig',
    ]);
    expect(cors.rustdoc[0].markdown).toContain('preflight');
  });

  it('skips passages whose file is missing, as in a container without the docs', () => {
    const docs = slotDocs(() => null);
    expect(docs['plugins-pre'].docs).toEqual([]);
    expect(docs['plugins-pre'].adrs).toEqual([]);
    expect(docs['plugins-pre'].rustdoc.length).toBeGreaterThan(0);
  });
});
