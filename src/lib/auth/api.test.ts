import { describe, expect, it, vi } from 'vitest';

// The default getter pulls in Auth.js and next/navigation; these tests inject their own.
vi.mock('./session', () => ({ getCurrentUser: async () => null }));

const { withUser } = await import('./api');
type User = Parameters<Parameters<typeof withUser>[0]>[0];

const user: User = {
  id: 'u1',
  orgId: 'org-under-test',
  email: 'ada@example.com',
  name: 'Ada',
  passwordHash: 'x',
  passwordChangedAt: null,
  role: 'owner',
  disabled: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('withUser', () => {
  it("answers 401 in the gateway's envelope without calling the handler", async () => {
    const handler = vi.fn(async () => new Response('reached'));
    const guarded = withUser(handler, async () => null);
    const response = await guarded(new Request('http://dash/api/g2/apis'));
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: expect.stringMatching(/authentication/) });
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes the user, request and remaining arguments through', async () => {
    const handler = vi.fn(async (_user: User, _request: Request, extra: string) =>
      Response.json({ extra }),
    );
    const guarded = withUser(handler, async () => user);
    const request = new Request('http://dash/api/g2/apis');
    const response = await guarded(request, 'ctx');
    expect(await response.json()).toEqual({ extra: 'ctx' });
    expect(handler).toHaveBeenCalledWith(user, request, 'ctx');
  });

  it('defaults to the real session check', async () => {
    const guarded = withUser(async () => new Response('reached'));
    expect((await guarded(new Request('http://dash/api/g2/apis'))).status).toBe(401);
  });
});
