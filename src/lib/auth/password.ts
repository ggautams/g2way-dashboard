import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing with Node's built-in scrypt — no native hashing dependency
 * (ADR-0004). A stored hash is self-describing:
 *
 *     scrypt$<N>$<r>$<p>$<salt, base64url>$<key, base64url>
 *
 * so the cost can be raised later without invalidating existing hashes: each is
 * verified with the parameters it was made with.
 *
 * Deliberately free of `server-only`: it holds no secret, and the bundle check
 * (`scripts/check-client-bundle.mjs`) imports it to seed a test account.
 */

/** Current cost: N = 2^15, r = 8, p = 1 (OWASP's scrypt baseline), 16-byte salt, 32-byte key. */
export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

/** Refuse hashes whose parameters would make verification a denial of service. */
const MAX_N = 2 ** 20;
const MAX_R = 32;
const MAX_P = 16;

function derive(password: string, salt: Buffer, keylen: number, options: ScryptOptions) {
  // scrypt needs 128·N·r bytes; Node's default 32 MiB cap is exactly N=2^15,r=8, so lift it.
  const maxmem = 256 * (options.N ?? 0) * (options.r ?? 0);
  return new Promise<Buffer>((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, keylen, { ...options, maxmem }, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const { N, r, p } = SCRYPT_PARAMS;
  const key = await derive(password, salt, KEY_BYTES, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

type Parsed = { N: number; r: number; p: number; salt: Buffer; key: Buffer };

function parse(stored: string): Parsed | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64url');
  const key = Buffer.from(parts[5], 'base64url');
  const valid =
    Number.isInteger(N) &&
    N > 1 &&
    N <= MAX_N &&
    (N & (N - 1)) === 0 &&
    Number.isInteger(r) &&
    r >= 1 &&
    r <= MAX_R &&
    Number.isInteger(p) &&
    p >= 1 &&
    p <= MAX_P &&
    salt.length > 0 &&
    key.length >= 16;
  return valid ? { N, r, p, salt, key } : null;
}

/** True when `password` matches `stored`. Constant-time in the key comparison. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (parsed === null) return false;
  const { N, r, p, salt, key } = parsed;
  const candidate = await derive(password, salt, key.length, { N, r, p });
  return timingSafeEqual(candidate, key);
}

let dummy: Promise<string> | undefined;

/**
 * Burns the same work as a real verification. Called when no account matches an
 * email, so response time does not reveal which emails have accounts.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, await dummy);
  return false;
}
