import { describe, expect, it } from 'vitest';
import { SECRET_MASK } from '@/lib/secrets/redact';
import {
  bodyRuleProblems,
  bodyTransformProblems,
  corsProblems,
  headerTransformProblems,
  isOrigin,
  mergeMasked,
  newBodyRule,
  splitMasked,
  templateProblem,
  transformProblems,
  withBodyRules,
  withHeaderTransform,
  withMaxResponseBytes,
  withoutHeader,
  type CorsConfig,
  type HeaderTransforms,
} from './transforms';
import type { ApiDefinition } from './list';

const headers = (t: HeaderTransforms) => headerTransformProblems(t, 'transform_headers');
const cors = (c: Partial<CorsConfig>) =>
  corsProblems({ allowed_origins: ['https://a.example'], ...c });

describe('headerTransformProblems (HeaderTransforms::validate)', () => {
  it('passes the contract’s example and an empty block', () => {
    expect(
      headers({
        request: { add: { 'X-Env': 'prod' }, remove: ['X-Internal-Debug'] },
        response: { add: { 'X-Gateway': 'g2way' }, remove: ['Server'] },
      }),
    ).toEqual({});
    expect(headers({})).toEqual({});
  });

  it('refuses bad names, hop-by-hop adds (any case) and bad values, per direction', () => {
    expect(headers({ request: { add: { 'bad name': 'x' } } })).toEqual({
      'transform_headers.request.add': 'Not a valid header name: bad name',
    });
    for (const name of ['Connection', 'transfer-encoding', 'Upgrade']) {
      expect(headers({ response: { add: { [name]: 'x' } } }), name).toHaveProperty([
        'transform_headers.response.add',
      ]);
    }
    expect(headers({ request: { add: { 'X-A': 'line\nbreak' } } })).toHaveProperty([
      'transform_headers.request.add',
    ]);
    expect(headers({ response: { remove: ['ok', 'not ok'] } })).toEqual({
      'transform_headers.response.remove': 'Not a valid header name: not ok',
    });
  });

  it('lets a hop-by-hop header be removed (harmless, as g2way allows)', () => {
    expect(headers({ response: { remove: ['Connection'] } })).toEqual({});
  });

  it('refuses a value masked for this role (ADR-0010), under any prefix', () => {
    const problems = headerTransformProblems(
      { request: { add: { 'X-Upstream-Key': SECRET_MASK } } },
      'versions.v2.transform_headers',
    );
    expect(problems['versions.v2.transform_headers.request.add']).toMatch(/hidden from your role/);
  });
});

describe('header editing', () => {
  it('drops empty directions, then the block on the base; an override keeps {}', () => {
    const t: HeaderTransforms = { request: { add: { 'X-A': '1' } }, response: { remove: ['S'] } };
    expect(withHeaderTransform(t, 'request', { add: {}, remove: [] })).toEqual({
      response: { remove: ['S'] },
    });
    expect(withHeaderTransform({ request: { remove: ['X'] } }, 'request', {})).toBeUndefined();
    expect(withHeaderTransform({ request: { remove: ['X'] } }, 'request', {}, true)).toEqual({});
    expect(withHeaderTransform(undefined, 'response', { add: { 'X-B': '2' } })).toEqual({
      response: { add: { 'X-B': '2' } },
    });
  });

  it('keeps masked values out of the text and puts them back unless retyped', () => {
    const add = { 'X-Env': 'prod', 'X-Key': SECRET_MASK };
    const { open, hidden } = splitMasked(add);
    expect(open).toEqual({ 'X-Env': 'prod' });
    expect(hidden).toEqual(['X-Key']);
    expect(mergeMasked({ 'X-Env': 'dev' }, add, hidden)).toEqual({
      'X-Env': 'dev',
      'X-Key': SECRET_MASK,
    });
    expect(mergeMasked({ 'X-Key': 'typed' }, add, hidden)).toEqual({ 'X-Key': 'typed' });
    expect(mergeMasked(undefined, {}, [])).toBeUndefined();
    expect(withoutHeader(add, 'X-Key')).toEqual({ 'X-Env': 'prod' });
    expect(withoutHeader({ 'X-Key': SECRET_MASK }, 'X-Key')).toBeUndefined();
  });
});

describe('templateProblem', () => {
  it('passes the documented templates', () => {
    for (const template of [
      '{"order": {{ body.id | tojson }}, "src": "g2"}',
      '{"data": {{ body | tojson }}, "status": {{ _g2.status }}}',
      '{"wrapped": {{ raw | tojson }}}',
      '{% if body %}{{ body | tojson }}{% else %}{{ raw | tojson }}{% endif %}',
      '{%- for x in body -%}{{ x }}{% endfor %}',
      '{% set n = 1 %}{{ n }}',
      '{% raw %}{{ not parsed {% if %}{% endraw %}',
      '{{ "}}" }}{# a comment with {{ #}',
    ]) {
      expect(templateProblem(template), template).toBeUndefined();
    }
  });

  it('reports unclosed delimiters, strings and blocks', () => {
    expect(templateProblem('{{ unclosed')).toMatch(/Unclosed \{\{/);
    expect(templateProblem('a\n{% if x')).toMatch(/line 2/);
    expect(templateProblem('{{ "open }}')).toMatch(/Unclosed string/);
    expect(templateProblem('{% if x %}y')).toMatch(/never closed with \{% endif %\}/);
    expect(templateProblem('{% for x in y %}{% endif %}')).toMatch(/expected \{% endfor %\}/);
    expect(templateProblem('{% endif %}')).toMatch(/closes nothing/);
    expect(templateProblem('{% else %}')).toMatch(/outside/);
    expect(templateProblem('{% raw %}x')).toMatch(/endraw/);
  });
});

describe('bodyTransformProblems (BodyTransforms::validate)', () => {
  it('passes the documented block, and nothing for no block', () => {
    expect(
      bodyTransformProblems(
        {
          request: [
            {
              pattern: '^/orders/submit$',
              methods: ['POST'],
              template: '{"order": {{ body | tojson }}}',
            },
          ],
          response: [{ pattern: '^/orders/', template: '{"data": {{ body | tojson }}}' }],
          max_response_body_bytes: 1048576,
        },
        'transform_body',
      ),
    ).toEqual({});
    expect(bodyTransformProblems(undefined, 'transform_body')).toEqual({});
  });

  it('refuses a present block with no rules, and a zero cap', () => {
    expect(bodyTransformProblems({}, 'transform_body')).toHaveProperty(['transform_body']);
    const zero = bodyTransformProblems(
      { request: [newBodyRule('/a/')], max_response_body_bytes: 0 },
      'transform_body',
    );
    expect(Object.keys(zero)).toEqual(['transform_body.max_response_body_bytes']);
  });

  it('keys rule problems <prefix>.<direction>.<index>.<setting>', () => {
    const problems = bodyTransformProblems(
      {
        request: [newBodyRule('/a/'), { pattern: '(', methods: ['FETCH'], template: '' }],
        response: [{ pattern: '^/', template: '{{ x', content_type: 'line\nbreak' }],
      },
      'transform_body',
    );
    expect(Object.keys(problems).sort()).toEqual([
      'transform_body.request.1.methods',
      'transform_body.request.1.pattern',
      'transform_body.request.1.template',
      'transform_body.response.0.content_type',
      'transform_body.response.0.template',
    ]);
    expect(problems['transform_body.request.1.template']).toMatch(/must not be empty/);
  });

  it('starts a new rule anchored and valid', () => {
    const rule = newBodyRule('/orders/');
    expect(rule.pattern).toBe('^/orders/');
    expect(bodyRuleProblems(rule)).toEqual({});
  });
});

describe('body editing', () => {
  it('drops an emptied list, then the block on the base unless a cap is set', () => {
    const rule = newBodyRule('/');
    expect(withBodyRules({ request: [rule] }, 'request', undefined)).toBeUndefined();
    expect(withBodyRules({ request: [rule] }, 'request', undefined, true)).toEqual({});
    expect(withBodyRules({ request: [rule], max_response_body_bytes: 10 }, 'request', [])).toEqual({
      max_response_body_bytes: 10,
    });
    expect(withBodyRules(undefined, 'response', [rule])).toEqual({ response: [rule] });
    expect(withMaxResponseBytes({ response: [rule] }, 5)).toEqual({
      response: [rule],
      max_response_body_bytes: 5,
    });
    expect(withMaxResponseBytes({ max_response_body_bytes: 5 }, undefined)).toBeUndefined();
  });
});

describe('corsProblems (CorsConfig::validate)', () => {
  it('passes minimal, wildcard-without-credentials and ported origins', () => {
    expect(cors({})).toEqual({});
    expect(corsProblems({ allowed_origins: ['*'] })).toEqual({});
    expect(cors({ allowed_origins: ['http://localhost:3000', 'https://a.example:8443'] })).toEqual(
      {},
    );
    expect(corsProblems(undefined)).toEqual({});
  });

  it('refuses each case g2way’s own tests refuse', () => {
    const cases: [Partial<CorsConfig>, string][] = [
      [{ allowed_origins: [] }, 'cors.allowed_origins'],
      [{ allowed_origins: ['*', 'https://a.example'] }, 'cors.allowed_origins'],
      [{ allowed_origins: ['*'], allow_credentials: true }, 'cors.allow_credentials'],
      [{ allowed_origins: ['https://a.example/path'] }, 'cors.allowed_origins'],
      [{ allowed_origins: ['a.example'] }, 'cors.allowed_origins'],
      [{ allowed_origins: ['ftp://a.example'] }, 'cors.allowed_origins'],
      [{ allowed_origins: ['https://user@a.example'] }, 'cors.allowed_origins'],
      [{ allowed_methods: [] }, 'cors.allowed_methods'],
      [{ allowed_methods: ['FETCH'] }, 'cors.allowed_methods'],
      [{ allowed_headers: ['bad name'] }, 'cors.allowed_headers'],
      [{ exposed_headers: ['bad name'] }, 'cors.exposed_headers'],
    ];
    for (const [config, key] of cases) {
      expect(Object.keys(cors(config)), JSON.stringify(config)).toContain(key);
    }
  });

  it('reads origins as http::Uri does: lower-case scheme, no trailing slash', () => {
    expect(isOrigin('https://a.example')).toBe(true);
    expect(isOrigin('http://[::1]:8080')).toBe(true);
    expect(isOrigin('https://a.example/')).toBe(false);
    expect(isOrigin('HTTPS://a.example')).toBe(false);
    expect(isOrigin('https://a.example?x=1')).toBe(false);
  });
});

describe('transformProblems', () => {
  it('gathers the header, body and CORS problems of a definition', () => {
    const def = {
      api_id: 'a',
      name: 'A',
      listen_path: '/a/',
      target_url: 'http://a',
      transform_headers: { request: { add: { 'bad name': 'x' } } },
      transform_body: {},
      cors: { allowed_origins: [] },
    } satisfies ApiDefinition;
    expect(Object.keys(transformProblems(def)).sort()).toEqual([
      'cors.allowed_origins',
      'transform_body',
      'transform_headers.request.add',
    ]);
  });
});
