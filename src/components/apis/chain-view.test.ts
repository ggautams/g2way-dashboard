import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// No component renderer in this repo, so these guard the chain view at the source.
const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), 'utf8');

describe('ChainView', () => {
  const source = read('chain-view.tsx');

  it('renders from chainFor and anchors every node with chainAnchor', () => {
    expect(source).toContain('chainFor(draft)');
    expect(source).toContain('id={chainAnchor(slot.id, version)}');
    expect(source).toContain('id={chainAnchor(FORWARDER_ID, version)}');
    expect(source).not.toMatch(/id=\{?[`'"]chain-/);
  });

  it('shows the versioned split: shared slots, the dispatcher, then one chain per version', () => {
    expect(source).toContain('chain.outer.map(');
    expect(source).toContain('chainAnchor(DISPATCHER_ID)');
    expect(source).toContain('<EditLink slotId={DISPATCHER_ID} />');
    expect(source).toContain('chain.versions.map(');
  });

  it('links slots with an editor to their form section, only through editorAnchor', () => {
    expect(source).toContain('EDITOR_SLOTS.includes(slotId)');
    expect(source).toContain('href={`#${editorAnchor(slotId, own ? version : undefined)}`}');
    expect(source).toContain('<EditLink slotId={slot.id} version={version} />');
    expect(source).toContain('<EditLink slotId={FORWARDER_ID} version={version} />');
    expect(source).not.toMatch(/href=\{?[`'"]#edit-/);
  });

  it('links a version’s overridable slots, and its heading, to that version’s editor', () => {
    expect(source).toContain('VERSION_EDITOR_SLOTS.includes(slotId)');
    expect(source).toContain('href={`#${editorAnchor(DISPATCHER_ID, v.name)}`}');
  });

  it('says the chain is not live until saved and reloaded', () => {
    expect(source).toMatch(/not live until saved and\s+reloaded/);
  });

  it('is hook-free and imports nothing server-only, so either side can render it', () => {
    expect(source).not.toContain("'use client'");
    expect(source).not.toMatch(/\buse(State|Effect|Memo)\b/);
    expect(source).not.toMatch(/server-client|lib\/g2\//);
  });
});

describe('ChainView explain panels', () => {
  const source = read('chain-view.tsx');

  it('shows each slot’s panel for the draft’s auth mode, in a native <details>', () => {
    expect(source).toContain('explainEntries(explanation, authMode)');
    expect(source).toContain("draft.auth?.mode ?? 'auth_token'");
    expect(source).toContain('<details');
    expect(source).toContain('<Explain explanation={explanation} authMode={authMode} />');
    expect(source.match(/explanation=\{explain\[s\.slot\.id\]\}/g)).toHaveLength(3);
  });
});

describe('slotExplanations', () => {
  const source = read('slot-explain.tsx');

  it('is server-only and renders the markdown there', () => {
    expect(source).toMatch(/^import 'server-only';/);
    expect(source).not.toContain("'use client'");
    expect(source).toContain(
      '<Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS} skipHtml>',
    );
  });

  it('keeps only absolute links, and no images', () => {
    expect(source).toContain('const target = linkHref(href);');
    expect(source).toContain('img: ({ alt }) => <span>{alt}</span>');
  });

  it.each([
    '../../app/(app)/apis/new/page.tsx',
    '../../app/(app)/apis/view/[id]/page.tsx',
    '../../app/(app)/apis/import/page.tsx',
  ])('is passed to the designer by %s', (page) => {
    expect(read(page)).toContain('explain={slotExplanations()}');
  });
});

describe('ApiDesigner', () => {
  it('has a Chain tab rendering the live draft', () => {
    const source = read('api-designer.tsx');
    expect(source).toContain('<TabsTrigger value="chain">Chain</TabsTrigger>');
    expect(source).toContain('<ChainView draft={draft} explain={explain} />');
  });

  it('follows #edit- and #chain- links across tabs', () => {
    const source = read('api-designer.tsx');
    expect(source).toContain('onClickCapture={followAnchor}');
    expect(source).toMatch(/startsWith\('edit-'\) \? 'form'/);
    expect(source).toMatch(/startsWith\('chain-'\) \? 'chain'/);
  });
});
