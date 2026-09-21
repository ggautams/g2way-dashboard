import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * CLAUDE.md: "Never hardcode that literal — read it from config." The org id is
 * `G2_ORG_ID`, falling back to g2way's own default in exactly one place,
 * `src/lib/g2/environments.ts`. This guard fails if the literal `"default"` is
 * used *as an org id* anywhere else in `src/`: assigned to or compared with an
 * org field, used as a `G2_ORG_ID`/org fallback, put in an `org_id` query, or
 * passed to a function that takes an `orgId` parameter. Other `"default"`
 * strings (`export default`, a default environment, CSS) are not org ids and
 * are left alone. Tests asserting what the fallback resolves to (`toBe(...)`)
 * are fine; tests should otherwise use a stand-in org.
 */

const SRC = join(import.meta.dirname, '..');
const SELF = relative(SRC, import.meta.filename);

/** The one sanctioned occurrence: the config fallback. */
const ALLOWED = [{ file: 'lib/g2/environments.ts', line: "const FALLBACK_ORG_ID = 'default';" }];

const Q = `['"\`]`;
const LIT = `${Q}default${Q}`;
const ORG = String.raw`(?:org_?id|orgid|org|g2_org_id|getorgid\(\))`;

/** Patterns naming "default" as an org id; each is case-insensitive over identifiers. */
const PATTERNS: RegExp[] = [
  // orgId: 'default', org_id = 'default', ORG_ID === "default"
  new RegExp(String.raw`\b[\w$]*${ORG}\b['"]?\s*(?:===?|!==?|:|=)\s*${LIT}`, 'i'),
  // 'default' === orgId
  new RegExp(String.raw`${LIT}\s*(?:===?|!==?)\s*[\w$.]*${ORG}\b`, 'i'),
  // process.env.G2_ORG_ID ?? 'default', orgId || "default", getOrgId() ?? 'default'
  new RegExp(String.raw`${ORG}[\w$.'"\]\)]*\s*(?:\?\?|\|\|)\s*${LIT}`, 'i'),
  // ?org_id=default in a URL or query string
  /\borg_id=default\b/i,
  // params.set('org_id', 'default'), { org_id: ... } handled above
  new RegExp(String.raw`${Q}org_id${Q}\s*,\s*${LIT}`, 'i'),
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [path] : [];
  });
}

const files = sourceFiles(SRC)
  .map((path) => ({ file: relative(SRC, path), text: readFileSync(path, 'utf8') }))
  .filter(({ file }) => file !== SELF);

/** Names of functions declared in `src/` with an `orgId` parameter. */
function orgTakingFunctions(): string[] {
  const names = new Set<string>();
  for (const { text } of files) {
    for (const match of text.matchAll(/function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g)) {
      // The parameter list, up to its closing parenthesis (params may nest them).
      let depth = 1;
      let i = match.index + match[0].length;
      const start = i;
      while (i < text.length && depth > 0) {
        if (text[i] === '(') depth += 1;
        else if (text[i] === ')') depth -= 1;
        i += 1;
      }
      if (/\borgId\b/.test(text.slice(start, i))) names.add(match[1]);
    }
  }
  return [...names];
}

/** Every line naming "default" as an org id, as `file:line: text`. */
function findOrgLiterals(
  sources: { file: string; text: string }[],
  functions: readonly string[],
): { file: string; line: string; where: string }[] {
  const callPatterns = functions.map(
    (name) => new RegExp(String.raw`\b${name}\(\s*(?:[^()]*?,\s*)?${LIT}\s*[,)]`),
  );
  const hits: { file: string; line: string; where: string }[] = [];
  for (const { file, text } of sources) {
    text.split('\n').forEach((line, index) => {
      if ([...PATTERNS, ...callPatterns].some((pattern) => pattern.test(line))) {
        hits.push({ file, line: line.trim(), where: `${file}:${index + 1}: ${line.trim()}` });
      }
    });
  }
  return hits;
}

describe('the "default" org literal', () => {
  const functions = orgTakingFunctions();

  it('finds the data-layer and auth functions that take an orgId', () => {
    for (const name of ['findUserById', 'createFirstOwner', 'recordAudit', 'resolveSessionUser']) {
      expect(functions).toContain(name);
    }
  });

  it('appears as an org id only in the config fallback', () => {
    const hits = findOrgLiterals(files, functions);
    const unexpected = hits.filter(
      (hit) => !ALLOWED.some(({ file, line }) => hit.file === file && hit.line === line),
    );
    expect(unexpected.map((hit) => hit.where)).toEqual([]);
    // The allowlist is not stale: the fallback is still where it says, once.
    expect(hits.map((hit) => `${hit.file}: ${hit.line}`)).toEqual(
      ALLOWED.map(({ file, line }) => `${file}: ${line}`),
    );
  });

  it('catches each way of hardcoding it, and ignores other "default"s', () => {
    const flagged = [
      "const orgId = 'default';",
      '  org_id: "default",',
      "if (session.orgId === 'default') {",
      "if ('default' !== user.orgId) {",
      "const org = process.env.G2_ORG_ID ?? 'default';",
      "const org = getOrgId() || 'default';",
      'fetch(`${base}/g2/apis?org_id=default`);',
      "url.searchParams.set('org_id', 'default');",
      "await findUserById(handle, 'default', id);",
      "recordAudit(db, 'default', record)",
      "  ORG_ID: 'default',",
    ];
    const ignored = [
      'export default function Page() {}',
      "const env = registry.defaultId ?? 'default';",
      "expect(parseOrgId({})).toBe('default');",
      "variant: 'default',",
      '<Button kind="default" />',
      "resolveEnvironment('default', registry);",
    ];
    const hit = (line: string) =>
      findOrgLiterals([{ file: 'x.ts', text: line }], ['findUserById', 'recordAudit']).length > 0;
    for (const line of flagged) expect(hit(line), line).toBe(true);
    for (const line of ignored) expect(hit(line), line).toBe(false);
  });
});
