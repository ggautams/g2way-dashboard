import { describe, expect, it } from 'vitest';
import { filterCommands, type Command } from './commands';

const cmd = (id: string, label: string, group: string, keywords?: string[]): Command => ({
  id,
  label,
  group,
  keywords,
  run: () => {},
});

const COMMANDS = [
  cmd('overview', 'Go to Overview', 'Navigate', ['home']),
  cmd('gateway', 'Go to Gateway', 'Navigate', ['health', 'node']),
  cmd('dark', 'Dark theme', 'Theme'),
  cmd('light', 'Light theme', 'Theme'),
];

const ids = (query: string) => filterCommands(COMMANDS, query).map((c) => c.id);

describe('filterCommands', () => {
  it('returns everything, in order, for an empty query', () => {
    expect(ids('')).toEqual(['overview', 'gateway', 'dark', 'light']);
    expect(ids('   ')).toEqual(['overview', 'gateway', 'dark', 'light']);
  });

  it('matches labels case-insensitively', () => {
    expect(ids('GATEW')).toEqual(['gateway']);
  });

  it('matches keywords and groups', () => {
    expect(ids('health')).toEqual(['gateway']);
    expect(ids('theme')).toEqual(['dark', 'light']);
  });

  it('requires every term to match', () => {
    expect(ids('go home')).toEqual(['overview']);
    expect(ids('go nothing')).toEqual([]);
  });

  it('ranks word-start label matches above keyword-only matches', () => {
    const commands = [
      cmd('a', 'Audit log', 'Navigate', ['node']),
      cmd('b', 'Node view', 'Navigate'),
    ];
    expect(filterCommands(commands, 'node').map((c) => c.id)).toEqual(['b', 'a']);
  });
});
