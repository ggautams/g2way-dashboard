import { describe, expect, it } from 'vitest';
import { SCRYPT_PARAMS, hashPassword, verifyAgainstDummy, verifyPassword } from './password';

describe('password hashing', () => {
  it('round-trips and rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyPassword('correct horse battery stapler', stored)).toBe(false);
  });

  it('encodes its parameters and a fresh salt in every hash', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    expect(a).not.toBe(b);
    const { N, r, p } = SCRYPT_PARAMS;
    expect(a).toMatch(new RegExp(`^scrypt\\$${N}\\$${r}\\$${p}\\$[\\w-]+\\$[\\w-]+$`));
  });

  it('verifies with the parameters stored in the hash, not the current ones', async () => {
    // A cheaper hash made with N=2^10: still verifies after the default cost moved on.
    const stored = await hashPassword('pw');
    const [, , , , salt] = stored.split('$');
    const { scryptSync } = await import('node:crypto');
    const key = scryptSync('pw', Buffer.from(salt, 'base64url'), 32, { N: 1024, r: 8, p: 1 });
    const old = `scrypt$1024$8$1$${salt}$${key.toString('base64url')}`;
    expect(await verifyPassword('pw', old)).toBe(true);
    expect(await verifyPassword('pw!', old)).toBe(false);
  });

  it('normalises Unicode so composed and decomposed input match', async () => {
    const stored = await hashPassword('café-password');
    expect(await verifyPassword('café-password', stored)).toBe(true);
  });

  it('treats malformed or abusive hashes as a mismatch, never a crash', async () => {
    for (const bad of [
      '',
      'plaintext',
      'bcrypt$10$abc',
      'scrypt$1000$8$1$c2FsdA$a2V5a2V5a2V5a2V5a2V5a2V5', // N not a power of two
      `scrypt$${2 ** 30}$8$1$c2FsdA$a2V5a2V5a2V5a2V5a2V5a2V5`, // N far too large
      'scrypt$1024$8$1$$a2V5a2V5a2V5a2V5a2V5a2V5', // no salt
    ]) {
      expect(await verifyPassword('pw', bad), bad).toBe(false);
    }
  });

  it('has a dummy verification that always fails', async () => {
    expect(await verifyAgainstDummy('anything')).toBe(false);
  });
});
