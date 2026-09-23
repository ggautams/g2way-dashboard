import { describe, expect, it, vi } from 'vitest';
import { PrometheusSource, parseEnvironments, resolveEnvironment } from '@/lib/g2/environments';
import { PrometheusError, loadPrometheusTraffic, queryRange, type RangeWindow } from './prometheus';

const PASSWORD = 'hunter2-prom';
const TOKEN = 'tok-secret-prom';
const WINDOW: RangeWindow = { start: 1_790_000_060, end: 1_790_003_600, stepSeconds: 60 };

/** The source a registry builds from `G2_PROMETHEUS_*` variables. */
function source(env: Record<string, string>): PrometheusSource {
  const registry = parseEnvironments({ G2_ADMIN_SECRET: 's', ...env });
  const prometheus = resolveEnvironment(undefined, registry).prometheus;
  if (prometheus === null) throw new Error('no Prometheus configured');
  return prometheus;
}

const basic = () =>
  source({ G2_PROMETHEUS_URL: `https://grafana:${PASSWORD}@prom.internal/api/prom/` });
const bearer = () =>
  source({ G2_PROMETHEUS_URL: 'http://prom.internal:9090', G2_PROMETHEUS_TOKEN: TOKEN });

function reply(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

const MATRIX = {
  status: 'success',
  data: {
    resultType: 'matrix',
    result: [{ metric: { http_response_status_code: '200' }, values: [[1_790_000_060, '12']] }],
  },
};

describe('queryRange', () => {
  it('POSTs the query form to /api/v1/query_range, with Basic auth from the URL', async () => {
    const fetch = vi.fn(async () => reply(MATRIX));
    const result = await queryRange(basic(), 'up', WINDOW, { fetch });
    expect(result.series).toEqual(MATRIX.data.result);
    expect(result.warnings).toEqual([]);

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    // No userinfo in the URL: fetch refuses one that carries credentials.
    expect(url).toBe('https://prom.internal/api/prom/api/v1/query_range');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from(`grafana:${PASSWORD}`).toString('base64')}`,
    );
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      query: 'up',
      start: '1790000060',
      end: '1790003600',
      step: '60s',
      timeout: '10s',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends a bearer token, or no Authorization at all', async () => {
    const fetch = vi.fn(async () => reply(MATRIX));
    await queryRange(bearer(), 'up', WINDOW, { fetch });
    await queryRange(source({ G2_PROMETHEUS_URL: 'http://prom:9090' }), 'up', WINDOW, { fetch });
    const headers = fetch.mock.calls.map(
      (call) =>
        ((call as unknown as [string, RequestInit])[1].headers as Record<string, string>)
          .authorization,
    );
    expect(headers).toEqual([`Bearer ${TOKEN}`, undefined]);
  });

  it("surfaces Prometheus's own error, with its type", async () => {
    const fetch = vi.fn(async () =>
      reply(
        {
          status: 'error',
          errorType: 'bad_data',
          error: 'invalid parameter "query": 1:5: parse error: unexpected <EOF>',
        },
        { status: 400 },
      ),
    );
    await expect(queryRange(bearer(), 'sum(', WINDOW, { fetch })).rejects.toThrow(
      new PrometheusError(
        'Prometheus bad_data: invalid parameter "query": 1:5: parse error: unexpected <EOF>',
      ),
    );
  });

  it('scrubs the URL and credentials from anything it shows', async () => {
    const fetch = vi.fn(async () =>
      reply({
        status: 'error',
        errorType: 'execution',
        error: `upstream https://prom.internal/api/prom rejected ${PASSWORD} and ${TOKEN}`,
      }),
    );
    const error = await queryRange(basic(), 'up', WINDOW, { fetch }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PrometheusError);
    const message = (error as Error).message;
    expect(message).not.toContain(PASSWORD);
    expect(message).not.toContain('prom.internal');
    expect(message).toContain('[redacted]');

    const tokenError = await queryRange(bearer(), 'up', WINDOW, { fetch }).catch((e: unknown) => e);
    expect((tokenError as Error).message).not.toContain(TOKEN);
  });

  it('reports a refused connection by its code, never the URL', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error(`connect ECONNREFUSED prom.internal:443 ${PASSWORD}`), {
          code: 'ECONNREFUSED',
        }),
      });
    });
    await expect(queryRange(basic(), 'up', WINDOW, { fetch })).rejects.toThrow(
      'Prometheus is unreachable (ECONNREFUSED)',
    );
  });

  it('gives up after the timeout', async () => {
    const fetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    );
    await expect(queryRange(bearer(), 'up', WINDOW, { fetch, timeoutMs: 20 })).rejects.toThrow(
      'Prometheus did not answer within 0.02 s',
    );
  });

  it('names the HTTP status of a reply that is not Prometheus JSON', async () => {
    const fetch = vi.fn(async () =>
      reply('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
    );
    await expect(queryRange(bearer(), 'up', WINDOW, { fetch })).rejects.toThrow(
      'Prometheus answered HTTP 502 Bad Gateway',
    );
  });

  it('refuses a result that is not a well-formed matrix', async () => {
    const vector = vi.fn(async () =>
      reply({ status: 'success', data: { resultType: 'vector', result: [] } }),
    );
    await expect(queryRange(bearer(), 'up', WINDOW, { fetch: vector })).rejects.toThrow(
      'Prometheus answered without a range-query matrix',
    );
    const malformed = vi.fn(async () =>
      reply({ status: 'success', data: { resultType: 'matrix', result: [{ metric: {} }] } }),
    );
    await expect(queryRange(bearer(), 'up', WINDOW, { fetch: malformed })).rejects.toThrow(
      'Prometheus answered with a malformed matrix',
    );
  });

  it('passes on warnings', async () => {
    const fetch = vi.fn(async () => reply({ ...MATRIX, warnings: ['partial response'] }));
    expect((await queryRange(bearer(), 'up', WINDOW, { fetch })).warnings).toEqual([
      'partial response',
    ]);
  });
});

describe('loadPrometheusTraffic', () => {
  it('runs the three queries at the end of each step, scoped to org and environment', async () => {
    const queries: string[] = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init!.body as URLSearchParams;
      queries.push(form.get('query')!);
      expect([form.get('start'), form.get('end'), form.get('step')]).toEqual([
        '1790000060',
        '1790003600',
        '60s',
      ]);
      return reply({ ...MATRIX, warnings: ['partial response'] });
    });
    const prometheus = source({
      G2_PROMETHEUS_URL: 'http://prom:9090',
      G2_PROMETHEUS_SELECTOR: 'job="g2way-prod"',
    });
    const traffic = await loadPrometheusTraffic(
      prometheus,
      {
        orgId: 'acme',
        apiId: 'users',
        status: null,
        from: 1_790_000_000_000,
        to: 1_790_003_600_000,
        stepSeconds: 60,
        grouping: null,
      },
      { fetch },
    );
    expect(queries).toHaveLength(3);
    for (const query of queries) {
      expect(query).toContain('{g2_org_id="acme",g2_api_id="users",job="g2way-prod"}[60s]');
    }
    expect(traffic.groups.get('')![0]).toMatchObject({ start: 1_790_000_000_000, requests: 12 });
    expect(traffic.warnings).toEqual(['partial response']);
  });
});

// Needs a real Prometheus: `make test-prometheus` starts one in Docker and
// sets TEST_PROMETHEUS_URL. Plain `npm run test` skips this block. The
// Prometheus scrapes no gateway, so it proves the transport and error
// handling against the real API, not the metric.
const TEST_PROMETHEUS_URL = process.env.TEST_PROMETHEUS_URL;

describe.skipIf(!TEST_PROMETHEUS_URL)('queryRange against a live Prometheus', () => {
  const live = () => source({ G2_PROMETHEUS_URL: TEST_PROMETHEUS_URL! });
  const now = Math.floor(Date.now() / 1000);
  const window = { start: now - 600, end: now, stepSeconds: 60 };

  it('answers the dashboard’s own queries with a (here empty) matrix', async () => {
    const traffic = await loadPrometheusTraffic(live(), {
      orgId: 'acme',
      apiId: null,
      status: '5xx',
      from: (now - 600) * 1000,
      to: now * 1000,
      stepSeconds: 60,
      grouping: { group: 'class', dimension: 'status' },
    });
    expect(traffic.groups.size).toBe(0);
  });

  it('returns a matrix for a metric Prometheus has', async () => {
    const result = await queryRange(live(), 'up', window);
    expect(result.series.length).toBeGreaterThan(0);
  });

  it('surfaces its parse error', async () => {
    await expect(queryRange(live(), 'sum(', window)).rejects.toThrow(/^Prometheus bad_data: /);
  });
});
