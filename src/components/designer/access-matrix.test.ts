import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// No component renderer in this repo, so these guard the matrix at the source.
const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), 'utf8');

describe('AccessMatrix', () => {
  const source = read('access-matrix.tsx');

  it('edits access only through the pure helpers, never by hand', () => {
    for (const helper of ['addApi(', 'removeApi(', 'withApiEntry(', 'withAccessField(']) {
      expect(source).toContain(helper);
    }
    expect(source).not.toMatch(/delete\s+\w+\[/);
  });

  it('says that an empty map grants every API, and marks dangling ids', () => {
    expect(source).toContain('every API in the organisation');
    expect(source).toContain('danglingApis(');
    expect(source).toMatch(/not found/);
  });

  it('is read-only while a policy overrides it', () => {
    expect(source).toMatch(/<fieldset\s+disabled=\{overridden\}/);
  });

  it('imports nothing server-only (it is a client component)', () => {
    expect(source.startsWith("'use client';")).toBe(true);
    expect(source).not.toMatch(/access-help|server-client|lib\/g2\/apis/);
  });
});

describe('the designers', () => {
  it('both render the shared matrix instead of the raw-only note', () => {
    for (const path of ['../policies/policy-form.tsx', '../keys/key-form.tsx']) {
      const source = read(path);
      expect(source).toContain('<AccessMatrix');
      expect(source).not.toContain('in the JSON or YAML view');
    }
  });

  it('the key form disables its own limits and access while a policy is applied', () => {
    const source = read('../keys/key-form.tsx');
    expect(source).toMatch(/<fieldset disabled=\{policyApplied\}/);
    expect(source).toContain('overriddenBy={policyApplied ? applied : null}');
  });
});
