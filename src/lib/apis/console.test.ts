import { describe, expect, it } from 'vitest';
import { CONSOLE_PATH, parseHeaderText, postConsoleRequest } from './console';

describe('parseHeaderText', () => {
  it('keeps order and duplicates, and skips blank lines', () => {
    expect(parseHeaderText('Authorization: Bearer a:b\n\nX-A: 1\nx-a: 2\n')).toEqual({
      ok: true,
      value: [
        ['Authorization', 'Bearer a:b'],
        ['X-A', '1'],
        ['x-a', '2'],
      ],
    });
  });

  it('names a line without a colon', () => {
    expect(parseHeaderText('nonsense')).toEqual({
      ok: false,
      error: 'Write each header as Name: value — nonsense',
    });
  });
});

describe('postConsoleRequest', () => {
  const REQUEST = {
    apiId: 'users',
    method: 'GET' as const,
    path: '',
    headers: [],
    body: '',
    version: null,
  };

  it('posts to the BFF with the environment header, and passes its error on verbatim', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([String(input), init]);
      return Response.json({ error: 'forbidden: the viewer role lacks …' }, { status: 403 });
    }) as typeof globalThis.fetch;
    expect(await postConsoleRequest('dev', REQUEST, { fetch })).toEqual({
      ok: false,
      error: 'forbidden: the viewer role lacks …',
      status: 403,
    });
    const [url, init] = calls[0] ?? [];
    expect(url).toBe(`/api${CONSOLE_PATH}`);
    expect(new Headers(init?.headers).get('x-g2-environment')).toBe('dev');
    expect(JSON.parse(String(init?.body))).toEqual(REQUEST);
  });

  it('says so when the answer carries no response', async () => {
    const fetch = (async () => Response.json({})) as typeof globalThis.fetch;
    const result = await postConsoleRequest('dev', REQUEST, { fetch });
    expect(result.ok).toBe(false);
  });
});
