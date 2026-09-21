import 'server-only';

import { createHash } from 'node:crypto';
import {
  clearFailures,
  countFailures,
  recordFailures,
  type ThrottleKey,
} from '@/lib/db/login-failures';
import type { ThrottleKind } from '@/lib/db/schema/shared';
import { normaliseEmail, type DataHandle } from '@/lib/db/users';
import { attemptedEmail } from './audit';

/**
 * Sign-in throttling: failed sign-ins are counted per email tried and per
 * client address over a sliding window, and once either count reaches its
 * limit further attempts are refused without checking the password, until the
 * oldest failures age out of the window.
 *
 * - A throttled attempt is not itself counted, so an attacker who keeps
 *   hammering does not extend the lockout: they get `limit` guesses per window.
 * - Unknown emails are counted exactly like real ones, so being throttled
 *   reveals nothing about which addresses have accounts.
 * - A successful sign-in clears its email's failures (not the client's: one
 *   right password must not reset the budget for spraying other accounts).
 * - The per-email limit doubles as a lockout lever for anyone who knows an
 *   address. That is why the window is short, why the email limit is looser
 *   than a classic "3 strikes", and why every throttled attempt is audited.
 *
 * State lives in the dashboard database, so limits hold across restarts and
 * across replicas sharing a Postgres.
 */

export type ThrottlePolicy = { windowMs: number; limits: Record<ThrottleKind, number> };

export const THROTTLE_POLICY: ThrottlePolicy = {
  windowMs: 15 * 60 * 1000,
  limits: { email: 10, client: 30 },
};

/**
 * The email bucket's key: the normalised address when it looks like one (the
 * same test the audit log applies), otherwise a hash, since a non-address in
 * the email field is often a pasted password and must not be stored as typed.
 */
export function emailKey(email: string): string {
  const normalised = normaliseEmail(email);
  if (attemptedEmail(email) === normalised) return normalised;
  return `sha256:${createHash('sha256').update(normalised).digest('hex')}`;
}

/**
 * The client address a sign-in came from, or `null` when there is none to go
 * on. Next.js fills `X-Forwarded-For` with the socket's address when the
 * request has none, so the header is the only place the address appears.
 *
 * Behind a proxy we trust (`AUTH_TRUST_HOST`, as for the CSRF origin check),
 * the last entry is the one that proxy appended, the only one a client cannot
 * forge. Exposed directly, a client can send any value it likes; the
 * per-client limit is then advisory and the per-email limit is the real guard.
 * Either way we take the last entry, which is the socket address whenever the
 * client sent no header of its own.
 */
export function clientAddress(headers: Headers): string | null {
  const entries = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return entries.at(-1) ?? null;
}

/** The keys one attempt counts against. */
export function throttleKeys(email: string, client: string | null): ThrottleKey[] {
  const keys: ThrottleKey[] = [{ kind: 'email', key: emailKey(email) }];
  if (client !== null) keys.push({ kind: 'client', key: client });
  return keys;
}

export type ThrottleVerdict = { throttled: false } | { throttled: true; kind: ThrottleKind };

/** Whether an attempt against `keys` must be refused before any password check. */
export async function checkThrottle(
  handle: DataHandle,
  orgId: string,
  keys: readonly ThrottleKey[],
  now: Date = new Date(),
  policy: ThrottlePolicy = THROTTLE_POLICY,
): Promise<ThrottleVerdict> {
  const since = new Date(now.getTime() - policy.windowMs);
  for (const key of keys) {
    const failures = await countFailures(handle, orgId, key, since);
    if (failures >= policy.limits[key.kind]) return { throttled: true, kind: key.kind };
  }
  return { throttled: false };
}

/** Counts a failed attempt against every key. */
export async function noteFailure(
  handle: DataHandle,
  orgId: string,
  keys: readonly ThrottleKey[],
  now: Date = new Date(),
  policy: ThrottlePolicy = THROTTLE_POLICY,
): Promise<void> {
  await recordFailures(handle, orgId, keys, now, new Date(now.getTime() - policy.windowMs));
}

/** A right password: forget the failures against that email. */
export async function noteSuccess(handle: DataHandle, orgId: string, email: string): Promise<void> {
  await clearFailures(handle, orgId, { kind: 'email', key: emailKey(email) });
}
