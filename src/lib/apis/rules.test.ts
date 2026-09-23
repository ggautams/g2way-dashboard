import { describe, expect, it } from 'vitest';
import { SECRET_MASK } from '@/lib/secrets/redact';
import {
  formatHeaders,
  jsRegex,
  listProblems,
  moveBy,
  newRule,
  parseHeaderLines,
  problemsOf,
  regexProblem,
  removeAt,
  replaceAt,
  ruleProblems,
  starterPattern,
  toggleMethod,
} from './rules';

describe('regexProblem', () => {
  it('passes patterns both dialects accept, including the contract’s examples', () => {
    for (const pattern of [
      '^/users/internal/',
      '^/users/(\\d+)/profile$',
      '^/p/public/ping$',
      '[]a]',
      '[^]a]',
      '\\(?=literal',
      '',
    ]) {
      expect(regexProblem(pattern), pattern).toBeUndefined();
    }
  });

  it('translates Rust-only syntax instead of refusing it', () => {
    expect(regexProblem('^/u/(?P<id>\\d+)$')).toBeUndefined();
    expect(regexProblem('(?i)^/Users')).toBeUndefined();
    expect(regexProblem('^/a(?i:BC)$')).toBeUndefined();
    expect(regexProblem('(?-i)^/a')).toBeUndefined();
    expect(regexProblem('[[:alpha:]]+')).toBeUndefined();
  });

  it('refuses what g2way’s engine would: syntax errors, look-around, backreferences', () => {
    expect(regexProblem('(')).toMatch(/Not a valid regex/);
    expect(regexProblem('^/x(?=y)')).toMatch(/look-ahead/i);
    expect(regexProblem('(?<!a)b')).toMatch(/look-behind/i);
    expect(regexProblem('(a)\\1')).toMatch(/Backreferences/);
    expect(regexProblem('(?<n>a)\\k<n>')).toMatch(/Backreferences/);
  });

  it('says nothing when it cannot follow the pattern (verbose mode)', () => {
    expect(regexProblem('(?x) ^ / a ( ')).toBeUndefined();
  });
});

describe('newRule', () => {
  it('starts each kind anchored under the listen path, never as the match-all empty regex', () => {
    expect(starterPattern('/v1.0/')).toBe('^/v1\\.0/');
    expect(newRule('block_paths', '/o/')).toEqual({ pattern: '^/o/' });
    expect(newRule('url_rewrites', '/o/')).toEqual({ pattern: '^/o/', rewrite: '/' });
    expect(newRule('mock_responses', '/o/')).toEqual({ pattern: '^/o/', status: 200, body: '' });
    expect(newRule('endpoint_rate_limits', '/o/').rate).toEqual({ requests: 10, per_seconds: 60 });
  });
});

describe('list helpers', () => {
  it('replace, remove and move without touching the input', () => {
    const list = ['a', 'b', 'c'] as const;
    expect(replaceAt(list, 1, 'x')).toEqual(['a', 'x', 'c']);
    expect(removeAt(list, 0)).toEqual(['b', 'c']);
    expect(moveBy(list, 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveBy(list, 0, -1)).toEqual(['a', 'b', 'c']);
    expect(list).toEqual(['a', 'b', 'c']);
  });
});

describe('toggleMethod', () => {
  it('upper-cases, keeps g2way’s method order, and writes none as absent (every method)', () => {
    expect(toggleMethod(undefined, 'post')).toEqual(['POST']);
    expect(toggleMethod(['POST'], 'GET')).toEqual(['GET', 'POST']);
    expect(toggleMethod(['get'], 'GET')).toBeUndefined();
    expect(toggleMethod(['FOO', 'GET'], 'GET')).toEqual(['FOO']);
  });
});

describe('headers', () => {
  it('parse Name: value lines and format them back', () => {
    const parsed = parseHeaderLines('Content-Type: application/json\n\nX-A:  b:c ');
    expect(parsed).toEqual({
      ok: true,
      value: { 'Content-Type': 'application/json', 'X-A': 'b:c' },
    });
    expect(parseHeaderLines('  ')).toEqual({ ok: true, value: undefined });
    expect(parseHeaderLines('nocolon').ok).toBe(false);
    expect(formatHeaders({ A: '1', B: '2' })).toBe('A: 1\nB: 2');
  });
});

describe('ruleProblems', () => {
  it('mirrors PathRule::validate: a regex and standard methods', () => {
    expect(ruleProblems('block_paths', { pattern: '^/x$', methods: ['post'] })).toEqual({});
    expect(ruleProblems('block_paths', { pattern: '(', methods: ['CONNECT'] })).toEqual({
      pattern: expect.stringMatching(/regex/),
      methods: expect.stringMatching(/CONNECT/),
    });
  });

  it('mirrors UrlRewriteRule::validate: the rewrite starts with /', () => {
    expect(ruleProblems('url_rewrites', { pattern: '^/u/(\\d+)$', rewrite: '/people/$1' })).toEqual(
      {},
    );
    expect(ruleProblems('url_rewrites', { pattern: '^/u', rewrite: 'people' }).rewrite).toBe(
      'Must begin with /.',
    );
  });

  it('mirrors MockResponse::validate: status 100–599, header names, hop-by-hop, values', () => {
    const mock = { pattern: '^/ping$' };
    expect(ruleProblems('mock_responses', mock)).toEqual({});
    expect(ruleProblems('mock_responses', { ...mock, status: 99 }).status).toBeDefined();
    expect(ruleProblems('mock_responses', { ...mock, status: 600 }).status).toBeDefined();
    expect(ruleProblems('mock_responses', { ...mock, status: 599 }).status).toBeUndefined();
    const header = (headers: Record<string, string>) =>
      ruleProblems('mock_responses', { ...mock, headers }).headers;
    expect(header({ 'Content-Type': 'application/json' })).toBeUndefined();
    expect(header({ 'Bad Name': 'x' })).toMatch(/header name/);
    expect(header({ 'Transfer-Encoding': 'chunked' })).toMatch(/hop-by-hop/);
    expect(header({ 'X-A': 'line\nbreak' })).toMatch(/not a valid header value/);
    expect(header({ 'X-A': 'tab\tand café' })).toBeUndefined();
  });

  it('refuses a mock header value the role could not see (ADR-0010 name fallback)', () => {
    expect(
      ruleProblems('mock_responses', { pattern: '^/', headers: { 'X-Api-Key': SECRET_MASK } })
        .headers,
    ).toMatch(/hidden/);
  });

  it('mirrors EndpointRateLimit::validate: zero is refused, never unlimited', () => {
    const rule = { pattern: '^/s', rate: { requests: 10, per_seconds: 60 } };
    expect(ruleProblems('endpoint_rate_limits', rule)).toEqual({});
    expect(
      ruleProblems('endpoint_rate_limits', { ...rule, rate: { requests: 0, per_seconds: 60 } })
        .rate,
    ).toMatch(/at least 1/);
  });
});

describe('listProblems / problemsOf', () => {
  it('key problems as <list>.<index>.<setting> and read them back per rule', () => {
    const problems = listProblems('allow_paths', [
      { pattern: '^/ok' },
      { pattern: '(', methods: ['NOPE'] },
    ]);
    expect(Object.keys(problems).sort()).toEqual([
      'allow_paths.1.methods',
      'allow_paths.1.pattern',
    ]);
    const back = problemsOf(
      { ...problems, 'block_paths.0.pattern': 'x', name: 'y' },
      'allow_paths',
    );
    expect(back[0]).toBeUndefined();
    expect(back[1]?.methods).toMatch(/NOPE/);
    expect(back).toHaveLength(2);
  });
});

describe('jsRegex', () => {
  it('translates what it can follow, searched unanchored like g2way', () => {
    expect(jsRegex('^/users/(\\d+)$')?.test('/users/42')).toBe(true);
    expect(jsRegex('users')?.test('/api/users/1')).toBe(true);
    expect(jsRegex('^/(?P<id>\\d+)$')?.test('/7')).toBe(true);
    expect(jsRegex('[]a]')?.test(']')).toBe(true);
  });

  it('gives up (null) where the dialects differ in meaning, or on a bad pattern', () => {
    for (const pattern of ['(?i)^/users', '(?x) a b', '[[:alpha:]]', '(?=x)', '(a)\\1', '(']) {
      expect(jsRegex(pattern), pattern).toBeNull();
    }
  });
});
