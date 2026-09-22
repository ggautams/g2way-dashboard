import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// No component renderer in this repo, so these guard the panel and designers at the source.
const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), 'utf8');

describe('HistoryPanel', () => {
  const source = read('history-panel.tsx');

  it('is a client component that imports nothing server-only', () => {
    expect(source.startsWith("'use client';")).toBe(true);
    expect(source).not.toMatch(/load-history|config-versions|lib\/db'|server-client/);
  });

  it('offers loading only through historyRows, and never writes', () => {
    expect(source).toContain('historyRows(');
    expect(source).toMatch(/restorable !== null &&/);
    expect(source).not.toMatch(/fetch\(|SaveBar|save\(/);
  });

  it.each([
    ['API', '../apis/api-designer.tsx', 'isDraftShape'],
    ['policy', '../policies/policy-designer.tsx', 'isPolicyShape'],
  ])('the %s designer has a History tab that loads a version into the draft', (_, path, guard) => {
    const designer = read(path);
    expect(designer).toContain('<TabsTrigger value="history">History</TabsTrigger>');
    expect(designer).toContain('<HistoryPanel');
    expect(designer).toContain(`isShape={${guard}}`);
    expect(designer).toContain('canWrite={canWrite}');
    // Rollback is the draft, then the ordinary save bar (ADR-0008 §5).
    expect(designer).toMatch(/onRestore=\{\(version, entry\) => \{\s*setDraft\(version\);/);
    expect(designer).toContain('<RestoredNote');
  });
});
