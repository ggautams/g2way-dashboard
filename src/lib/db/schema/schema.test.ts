import { getTableColumns, getTableName, type InferSelectModel } from 'drizzle-orm';
import { getTableConfig as pgTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { getTableConfig as sqliteTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as pg from './pg';
import * as sqlite from './sqlite';

/**
 * ADR-0003: the SQLite and Postgres schemas are two declarations of one schema.
 * These tests fail the moment they disagree on a table, column, nullability,
 * key, index or the TypeScript type a row reads back as.
 */

type Shape = {
  table: string;
  columns: Record<string, { name: string; kind: string; notNull: boolean; primary: boolean }>;
  indexes: { name: string; unique: boolean; columns: string[] }[];
};

function columns(table: SQLiteTable | PgTable): Shape['columns'] {
  return Object.fromEntries(
    Object.entries(getTableColumns(table)).map(([key, column]) => [
      key,
      {
        name: column.name,
        kind: column.dataType,
        notNull: column.notNull,
        primary: column.primary,
      },
    ]),
  );
}

function indexColumns(columns: readonly unknown[]): string[] {
  return columns.map((column) =>
    column && typeof column === 'object' && 'name' in column ? String(column.name) : '?',
  );
}

function sqliteShape(table: SQLiteTable): Shape {
  const config = sqliteTableConfig(table);
  return {
    table: getTableName(table),
    columns: columns(table),
    indexes: config.indexes
      .map(({ config: index }) => ({
        name: index.name,
        unique: index.unique,
        columns: indexColumns(index.columns),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function pgShape(table: PgTable): Shape {
  const config = pgTableConfig(table);
  return {
    table: getTableName(table),
    columns: columns(table),
    indexes: config.indexes
      .map(({ config: index }) => ({
        name: index.name ?? '',
        unique: index.unique,
        columns: indexColumns(index.columns),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

describe('schema parity (SQLite ⇄ Postgres)', () => {
  it('declares the same tables under the same export names', () => {
    expect(Object.keys(pg).sort()).toEqual(Object.keys(sqlite).sort());
  });

  it.each(Object.keys(sqlite) as (keyof typeof sqlite)[])('%s has the same shape', (name) => {
    expect(pgShape(pg[name])).toEqual(sqliteShape(sqlite[name]));
  });

  it('every table carries a non-null org_id with no default (ADR-0003 §3)', () => {
    for (const table of [...Object.values(sqlite), ...Object.values(pg)]) {
      const columns = getTableColumns(table);
      expect(columns).toHaveProperty('orgId.name', 'org_id');
      expect(columns).toHaveProperty('orgId.notNull', true);
      // The caller must supply it from config; a default would let a write skip it.
      expect(columns).toHaveProperty('orgId.hasDefault', false);
    }
  });

  it('rows read back as the same TypeScript type', () => {
    expectTypeOf<InferSelectModel<typeof pg.users>>().toEqualTypeOf<
      InferSelectModel<typeof sqlite.users>
    >();
    expectTypeOf<InferSelectModel<typeof pg.auditLog>>().toEqualTypeOf<
      InferSelectModel<typeof sqlite.auditLog>
    >();
    expectTypeOf<InferSelectModel<typeof pg.loginFailures>>().toEqualTypeOf<
      InferSelectModel<typeof sqlite.loginFailures>
    >();
  });
});
