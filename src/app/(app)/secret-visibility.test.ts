import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static guard for ADR-0010: every page that hands a gateway body (an API
 * definition, a policy, a key session or a stored version of one) to the
 * browser reads it through a redacting loader, called with the signed-in
 * user's role. Pages never talk to the gateway client directly, and the list
 * pages only ever pass summaries on.
 */

const APP = resolve(import.meta.dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The argument text of every `name(...)` call in `text`, parentheses balanced. */
function callArguments(text: string, name: string): string[] {
  const calls: string[] = [];
  const pattern = new RegExp(`\\b${name}\\(`, 'g');
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
    }
    calls.push(text.slice(start, i - 1));
  }
  return calls;
}

const REDACTING_LOADERS = ['loadApi', 'loadPolicy', 'loadKey', 'loadHistory'];

describe('secret visibility in pages (ADR-0010)', () => {
  const files = sources(APP).map((path) => ({
    path: relative(APP, path),
    text: readFileSync(path, 'utf8'),
  }));

  it('no page or route reaches the gateway client itself', () => {
    const offenders = files
      .filter(({ path }) => !path.startsWith(join('api', 'g2')))
      .filter(({ text }) => /server-client|gatewayClient\(/.test(text))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('every redacting loader call passes the signed-in user’s role', () => {
    const calls = files.flatMap(({ path, text }) =>
      REDACTING_LOADERS.flatMap((name) =>
        callArguments(text, name).map((args) => ({ path, name, args })),
      ),
    );
    expect(calls.length).toBeGreaterThan(0);
    const offenders = calls.filter(({ args }) => !/\buser\.role\s*,?\s*$/.test(args.trim()));
    expect(offenders).toEqual([]);
  });

  it('every page rendering a designer loads its body through a redacting loader', () => {
    const designers: Record<string, string[]> = {
      ApiDesigner: ['loadApi', 'loadHistory'],
      PolicyDesigner: ['loadPolicy', 'loadHistory'],
      KeyDesigner: ['loadKey'],
    };
    const pages = files.filter(({ path }) => path.endsWith('page.tsx'));
    const checked: string[] = [];
    for (const { path, text } of pages) {
      for (const [designer, loaders] of Object.entries(designers)) {
        // A designer given a stored body (`original`/`stored`), not a blank new one.
        if (!new RegExp(`<${designer}[\\s\\S]*?(original|stored)=\\{(?!null\\})`).test(text))
          continue;
        checked.push(path);
        for (const loader of loaders) expect(text, `${path} ${loader}`).toContain(`${loader}(`);
      }
    }
    expect(checked.sort()).toEqual(
      [
        join('(app)', 'apis', 'view', '[id]', 'page.tsx'),
        join('(app)', 'keys', 'view', '[hash]', 'page.tsx'),
        join('(app)', 'policies', 'view', '[id]', 'page.tsx'),
      ].sort(),
    );
  });

  it('list pages pass summaries on, never the unredacted records', () => {
    const lists: Record<string, [loader: RegExp, summariser: string]> = {
      [join('(app)', 'apis', 'page.tsx')]: [/loadApis\(/, 'map(summarise)'],
      [join('(app)', 'policies', 'page.tsx')]: [/loadPolicies\(/, 'map(summarisePolicy)'],
      [join('(app)', 'keys', 'page.tsx')]: [/loadKey(Page|Search)\(/, 'toKeyListRow('],
    };
    for (const [path, [loader, summariser]] of Object.entries(lists)) {
      const text = files.find((file) => file.path === path)?.text ?? '';
      expect(text, path).toMatch(loader);
      expect(text, path).toContain(summariser);
    }
    // No other page uses the unredacted list loaders.
    const others = files
      .filter(({ path }) => !(path in lists))
      .filter(({ text }) => /\bload(Apis|Policies|KeyPage|KeySearch)\(/.test(text))
      .map(({ path }) => path);
    expect(others).toEqual([]);
  });
});
