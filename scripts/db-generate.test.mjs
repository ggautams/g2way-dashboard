import { describe, expect, it } from 'vitest';
import { CONFIGS, commands, parseArgs } from './db-generate.mjs';

describe('db:generate arguments', () => {
  it('accepts --name in both spellings', () => {
    expect(parseArgs(['--name', 'add_things'])).toEqual({ name: 'add_things', custom: false });
    expect(parseArgs(['--name=add_things', '--custom'])).toEqual({
      name: 'add_things',
      custom: true,
    });
  });

  it('requires a snake_case name', () => {
    expect(() => parseArgs([])).toThrow(/name is required/);
    expect(() => parseArgs(['--name'])).toThrow(/name is required/);
    expect(() => parseArgs(['--name', 'Add-Things'])).toThrow(/snake_case/);
  });

  it('rejects unknown flags rather than dropping them', () => {
    expect(() => parseArgs(['--name', 'x', '--prefix', 'none'])).toThrow(/unknown argument/);
  });

  it('passes the same name to every dialect config', () => {
    const runs = commands({ name: 'add_things', custom: true });
    expect(runs.map((argv) => argv[2])).toEqual(CONFIGS);
    for (const argv of runs) {
      expect(argv).toEqual(expect.arrayContaining(['--name', 'add_things', '--custom']));
    }
  });
});
