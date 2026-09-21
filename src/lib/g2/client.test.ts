import { describe, expect, expectTypeOf, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { components } from '../../../contracts/g2way.d.ts';
import { ENVIRONMENT_HEADER, bffClient, unwrap } from './client';
import { GatewayError } from './errors';

type Call = { request: Request };

/** A fake BFF: records each request and answers with `reply`. */
function fakeBff(reply: () => Response = () => Response.json([])) {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ request: new Request(input, init) });
    return reply();
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
}

const BASE = 'http://dashboard.test/api';

describe('bffClient', () => {
  it('calls /api/g2/... with the environment header and no secret', async () => {
    const bff = fakeBff(() => Response.json({ api_id: 'a/b' }));
    const client = bffClient('staging', { baseUrl: BASE, fetch: bff.fetch });
    await unwrap(client.GET('/g2/apis/{id}', { params: { path: { id: 'a/b' } } }));
    const [{ request }] = bff.calls;
    expect(request.method).toBe('GET');
    expect(request.url).toBe('http://dashboard.test/api/g2/apis/a%2Fb');
    expect(request.headers.get(ENVIRONMENT_HEADER)).toBe('staging');
    expect(request.headers.get('x-g2-authorization')).toBeNull();
  });

  it('omits the environment header for the default environment', async () => {
    const bff = fakeBff();
    await bffClient(undefined, { baseUrl: BASE, fetch: bff.fetch }).GET('/g2/apis');
    expect(bff.calls[0].request.headers.get(ENVIRONMENT_HEADER)).toBeNull();
  });

  it('sends a typed JSON body', async () => {
    const bff = fakeBff(() => new Response(null, { status: 201 }));
    const client = bffClient(undefined, { baseUrl: BASE, fetch: bff.fetch });
    const body = { api_id: 'a', name: 'A' } as components['schemas']['ApiDefinition'];
    await expect(unwrap(client.POST('/g2/apis', { body }))).resolves.toBeUndefined();
    const [{ request }] = bff.calls;
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(await request.json()).toEqual(body);
  });
});

describe('unwrap', () => {
  it('returns the success body, typed from the contract', async () => {
    const bff = fakeBff(() => Response.json([{ api_id: 'a' }]));
    const client = bffClient(undefined, { baseUrl: BASE, fetch: bff.fetch });
    const apis = await unwrap(client.GET('/g2/apis'));
    // openapi-fetch's `Readable<>` strips write-only fields, so this is `toExtend`, not equality.
    expectTypeOf(apis).not.toBeAny();
    expectTypeOf(apis).toExtend<components['schemas']['ApiDefinition'][]>();
    expect(apis).toEqual([{ api_id: 'a' }]);
  });

  it("throws the gateway's own error message and status", async () => {
    const bff = fakeBff(() =>
      Response.json(
        { error: 'api not found' },
        { status: 404, headers: { [ENVIRONMENT_HEADER]: 'dev' } },
      ),
    );
    const client = bffClient(undefined, { baseUrl: BASE, fetch: bff.fetch });
    const error = await unwrap(
      client.GET('/g2/apis/{id}', { params: { path: { id: 'x' } } }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({ status: 404, message: 'api not found', environment: 'dev' });
  });

  it('falls back to the status when the body is not the envelope', async () => {
    const bff = fakeBff(() => new Response('upstream exploded', { status: 503 }));
    const client = bffClient(undefined, { baseUrl: BASE, fetch: bff.fetch });
    await expect(unwrap(client.GET('/g2/node'))).rejects.toMatchObject({
      status: 503,
      message: 'HTTP 503',
    });
  });
});

describe('import boundary', () => {
  // These modules are importable from client components, so they must not pull in
  // anything that reads the admin secret. (The client-bundle test is the backstop.)
  for (const file of ['client.ts', 'errors.ts', 'org-scope.ts']) {
    it(`${file} imports nothing server-only`, () => {
      const source = readFileSync(resolve(__dirname, file), 'utf8');
      expect(source).not.toMatch(
        /from '(server-only|\.\/environments|\.\/proxy|\.\/server-client)'/,
      );
      expect(source).not.toMatch(/import 'server-only'/);
    });
  }
});
