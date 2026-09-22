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
    expect(source).toContain("chainAnchor('dispatcher')");
    expect(source).toContain('chain.versions.map(');
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

describe('ApiDesigner', () => {
  it('has a Chain tab rendering the live draft', () => {
    const source = read('api-designer.tsx');
    expect(source).toContain('<TabsTrigger value="chain">Chain</TabsTrigger>');
    expect(source).toContain('<ChainView draft={draft} />');
  });
});
