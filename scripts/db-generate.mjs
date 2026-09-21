#!/usr/bin/env node
// Writes a migration for both dialects from one schema change (ADR-0003 §5: one
// migration tree per dialect). drizzle-kit handles one dialect per config, so
// this runs it once per config with the same name, which keeps the two trees'
// file names aligned:
//
//   npm run db:generate -- --name add_login_attempts
//   make db-generate NAME=add_login_attempts
//
// A name is required: drizzle-kit's default is a random word pair, which tells
// the next reader nothing. `--custom` writes an empty migration for hand-written
// SQL, in both trees.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CONFIGS = ['drizzle.sqlite.config.ts', 'drizzle.pg.config.ts'];

const USAGE = 'usage: npm run db:generate -- --name <snake_case_name> [--custom]';

/** Parses `--name <n>` / `--name=<n>` and `--custom`; rejects anything else. */
export function parseArgs(argv) {
  let name;
  let custom = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--custom') custom = true;
    else if (arg === '--name') {
      name = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--name=')) name = arg.slice('--name='.length);
    else throw new Error(`unknown argument ${JSON.stringify(arg)}\n${USAGE}`);
  }
  if (!name) throw new Error(`a migration name is required\n${USAGE}`);
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`migration name must be snake_case, got ${JSON.stringify(name)}`);
  }
  return { name, custom };
}

/** The drizzle-kit argument lists, one per dialect config. */
export function commands({ name, custom }) {
  return CONFIGS.map((config) => [
    'generate',
    '--config',
    config,
    '--name',
    name,
    ...(custom ? ['--custom'] : []),
  ]);
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  for (const argv of commands(args)) {
    const result = spawnSync('drizzle-kit', argv, { stdio: 'inherit', shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
