import { describe, expect, it } from 'vitest';
import type { ApiDefinition } from '@/lib/apis/list';
import {
  DEFINITIONS_TTL_MS,
  compileTemplateRules,
  definitionPatterns,
  heuristicSegment,
  templatePath,
  templateRuleCache,
  type DefinitionsLoad,
} from './path-template';

function api(overrides: Partial<ApiDefinition> = {}): ApiDefinition {
  return {
    api_id: 'users',
    name: 'Users',
    listen_path: '/users/',
    target_url: 'http://users.internal',
    ...overrides,
  };
}

describe('heuristicSegment', () => {
  it.each([
    ['42', '{id}'],
    ['0', '{id}'],
    ['3f2504e0-4f89-11d3-9a0c-0305e82c3301', '{uuid}'],
    ['3F2504E0-4F89-11D3-9A0C-0305E82C3301', '{uuid}'],
    ['507f1f77bcf86cd799439011', '{hex}'],
    ['e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', '{hex}'],
    ['clx9v0q2r0000abcdxyz1234', '{token}'],
    ['01HZX3K5M7QJ8V2N4P6R9T0WYC', '{token}'],
    ['dGhpcy1pcy1hLXRva2VuX3dpdGgtQmFzZTY0', '{token}'],
  ])('templates %s as %s', (segment, template) => {
    expect(heuristicSegment(segment)).toBe(template);
  });

  it.each([
    'users',
    'v2',
    'orders.json',
    'deadbeef', // hex, but short
    'order-summary-for-the-quarter', // long, but a word slug
    'abcdefghijklmnopqrstuvwxyz', // long letters, no digit
    'report-2024-final-version', // lowercase slug with a year
    'me',
  ])('keeps %s', (segment) => {
    expect(heuristicSegment(segment)).toBeNull();
  });
});

describe('definitionPatterns', () => {
  it('reads every rule list, body transforms and version overrides', () => {
    const patterns = definitionPatterns(
      api({
        block_paths: [{ pattern: '^/a' }],
        url_rewrites: [{ pattern: '^/b', rewrite: '/b' }],
        transform_body: { response: [{ pattern: '^/c', template: '{}' }] },
        versioning: {
          versions: { v1: { mock_responses: [{ pattern: '^/d' }] } },
        },
      }),
    );
    expect(patterns).toEqual(['^/a', '^/b', '^/c', '^/d']);
  });
});

describe('compileTemplateRules', () => {
  it('keeps only patterns with a named group JavaScript can follow', () => {
    const rules = compileTemplateRules(
      api({
        allow_paths: [
          { pattern: '^/users/(\\d+)$' }, // unnamed: not a parameter
          { pattern: '^/users/(?P<user>\\d+)/orders/(?<order>[^/]+)$' },
          { pattern: '(?i)^/users/(?P<user>\\d+)$' }, // inline flags: not followed
          { pattern: '^/users/(?P<user>\\d+)/orders/(?<order>[^/]+)$' }, // duplicate
        ],
      }),
    );
    expect(rules.map((rule) => rule.names)).toEqual([['user', 'order']]);
  });
});

describe('templatePath', () => {
  it('templates by heuristic without rules', () => {
    expect(templatePath('/users/42/orders/507f1f77bcf86cd799439011')).toBe(
      '/users/{id}/orders/{hex}',
    );
    expect(templatePath('/users/')).toBe('/users/');
    expect(templatePath('/')).toBe('/');
    expect(templatePath('/users//42')).toBe('/users//{id}');
  });

  it('prefers the first matching rule with a named group, then the heuristic', () => {
    const rules = compileTemplateRules(
      api({
        url_rewrites: [
          { pattern: '^/users/(?P<handle>[a-z]+)/posts/', rewrite: '/p' },
          { pattern: '^/users/(?P<never>.+)$', rewrite: '/q' },
        ],
      }),
    );
    expect(templatePath('/users/alice/posts/42', rules)).toBe('/users/{handle}/posts/{id}');
    expect(templatePath('/users/42', rules)).toBe('/users/{never}');
    expect(templatePath('/orders/42', rules)).toBe('/orders/{id}');
  });

  it('keeps the literal part of a segment a group covers in part', () => {
    const rules = compileTemplateRules(api({ allow_paths: [{ pattern: '^/u(?P<n>\\d+)x$' }] }));
    expect(templatePath('/u42x', rules)).toBe('/u{n}x');
  });

  it('templates the outer group of nested groups, and skips empty captures', () => {
    const rules = compileTemplateRules(
      api({
        allow_paths: [{ pattern: '^/f/(?P<file>(?P<stem>[a-z]+)\\.(?P<ext>[a-z]+))(?P<tail>/?)$' }],
      }),
    );
    expect(templatePath('/f/readme.md', rules)).toBe('/f/{file}');
  });

  it('never templates the leading slash away', () => {
    const rules = compileTemplateRules(api({ allow_paths: [{ pattern: '^(?P<all>.*)$' }] }));
    expect(templatePath('/users/42', rules)).toBe('/users/{id}');
  });
});

describe('templateRuleCache', () => {
  const definitions: DefinitionsLoad = {
    ok: true,
    value: [api({ allow_paths: [{ pattern: '^/users/(?P<user>\\d+)$' }] })],
  };
  const silent = { info: () => {}, warn: () => {} };

  it('fetches once per TTL', async () => {
    let clock = 0;
    let loads = 0;
    const cache = templateRuleCache(
      'prod',
      async () => {
        loads += 1;
        return definitions;
      },
      { now: () => clock, log: silent },
    );
    expect((await cache.rules()).get('users')).toHaveLength(1);
    clock = DEFINITIONS_TTL_MS - 1;
    await cache.rules();
    expect(loads).toBe(1);
    clock = DEFINITIONS_TTL_MS;
    await cache.rules();
    expect(loads).toBe(2);
  });

  it('keeps the last good rules on failure, never throws, and logs each transition once', async () => {
    let clock = 0;
    const results: (DefinitionsLoad | Error)[] = [
      definitions,
      { ok: false, error: 'gateway unreachable' },
      new Error('registry: no such environment'),
      definitions,
    ];
    const lines: string[] = [];
    const cache = templateRuleCache(
      'prod',
      async () => {
        const next = results.shift();
        if (next instanceof Error) throw next;
        return next as DefinitionsLoad;
      },
      {
        now: () => clock,
        log: { info: (l: string) => void lines.push(l), warn: (l: string) => void lines.push(l) },
      },
    );
    for (let i = 0; i < 4; i++) {
      clock = i * DEFINITIONS_TTL_MS;
      expect((await cache.rules()).get('users')).toHaveLength(1);
    }
    expect(lines).toEqual([
      '[analytics-ingest] prod: API definitions unavailable, templating paths with the last ones fetched: gateway unreachable',
      '[analytics-ingest] prod: path templates from definitions again',
    ]);
  });

  it('falls back to no rules when the first fetch fails', async () => {
    const cache = templateRuleCache(
      'prod',
      async () => ({ ok: false, error: 'gateway unreachable' }),
      {
        log: silent,
      },
    );
    expect((await cache.rules()).size).toBe(0);
  });
});
