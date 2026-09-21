import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDatabase, migrationsFolder, openDatabase, type DashboardDatabase } from '.';
import * as pgSchema from './schema/pg';
import type * as sqliteSchema from './schema/sqlite';

// Stand-in org: the real one always comes from config (G2_ORG_ID), never a literal.
const ORG = 'org-under-test';

const user: typeof sqliteSchema.users.$inferInsert = {
  orgId: ORG,
  email: 'ada@example.com',
  name: 'Ada',
  passwordHash: 'not-a-real-hash',
  role: 'owner',
};

const audit: typeof sqliteSchema.auditLog.$inferInsert = {
  orgId: ORG,
  actorId: 'u1',
  actorEmail: 'ada@example.com',
  action: 'api.update',
  target: 'api:petstore',
  before: { listen_path: '/old' },
  after: { listen_path: '/new', tags: ['a'] },
  gatewayMethod: 'PUT',
  gatewayPath: '/g2/apis/petstore',
  gatewayStatus: 200,
};

const open: DashboardDatabase[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((database) => database.close()));
});

async function sqliteMemory() {
  const database = openDatabase({ dialect: 'sqlite', path: ':memory:' });
  open.push(database);
  await migrateDatabase(database);
  if (database.dialect !== 'sqlite') throw new Error('expected SQLite');
  return database;
}

describe('SQLite (default driver)', () => {
  it('applies the migrations idempotently', async () => {
    const database = await sqliteMemory();
    await migrateDatabase(database);
  });

  it('round-trips a user with defaults filled in', async () => {
    const { db, schema } = await sqliteMemory();
    const [inserted] = db.insert(schema.users).values(user).returning().all();
    expect(inserted.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(inserted.disabled).toBe(false);
    expect(inserted.createdAt).toBeInstanceOf(Date);

    const read = db.select().from(schema.users).where(eq(schema.users.id, inserted.id)).get();
    expect(read).toEqual(inserted);
  });

  it('keeps email unique per org, not globally', async () => {
    const { db, schema } = await sqliteMemory();
    db.insert(schema.users).values(user).run();
    expect(() => db.insert(schema.users).values(user).run()).toThrow(/UNIQUE/);
    db.insert(schema.users)
      .values({ ...user, orgId: 'another-org' })
      .run();
    const rows = db.select().from(schema.users).where(eq(schema.users.email, user.email)).all();
    expect(rows).toHaveLength(2);
  });

  it('round-trips audit before/after JSON and the gateway call', async () => {
    const { db, schema } = await sqliteMemory();
    const [inserted] = db.insert(schema.auditLog).values(audit).returning().all();
    const read = db.select().from(schema.auditLog).where(eq(schema.auditLog.id, inserted.id)).get();
    expect(read).toMatchObject(audit);
  });
});

describe('Postgres migrations (in-process PGlite)', () => {
  // PGlite is real Postgres compiled to WASM: it proves drizzle/pg/ applies and the
  // pg schema round-trips without a server. The node-postgres driver itself is
  // covered by the live test below.
  it('applies drizzle/pg and round-trips both tables', async () => {
    const client = new PGlite();
    try {
      const db = drizzlePglite(client, { schema: pgSchema });
      await migratePglite(db, { migrationsFolder: migrationsFolder('postgres') });

      const [inserted] = await db.insert(pgSchema.users).values(user).returning();
      expect(inserted.disabled).toBe(false);
      await expect(db.insert(pgSchema.users).values(user)).rejects.toThrow();

      const [entry] = await db.insert(pgSchema.auditLog).values(audit).returning();
      const [read] = await db
        .select()
        .from(pgSchema.auditLog)
        .where(eq(pgSchema.auditLog.id, entry.id));
      expect(read).toMatchObject(audit);
    } finally {
      await client.close();
    }
  });
});

// Needs a live Postgres; `make test-pg` starts one in Docker and sets TEST_POSTGRES_URL.
describe.skipIf(!process.env.TEST_POSTGRES_URL)('Postgres (node-postgres, live)', () => {
  it('migrates and round-trips through the real driver', async () => {
    const database = openDatabase({ dialect: 'postgres', url: process.env.TEST_POSTGRES_URL! });
    open.push(database);
    if (database.dialect !== 'postgres') throw new Error('expected Postgres');
    await migrateDatabase(database);
    await migrateDatabase(database);
    const { db, schema } = database;
    const orgId = `live-${crypto.randomUUID()}`;
    const [inserted] = await db
      .insert(schema.users)
      .values({ ...user, orgId })
      .returning();
    const [read] = await db.select().from(schema.users).where(eq(schema.users.id, inserted.id));
    expect(read).toEqual(inserted);
    await db.delete(schema.users).where(eq(schema.users.orgId, orgId));
  });
});
