import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  DARK_CLASS,
  THEME_STORAGE_KEY,
  parseThemePreference,
  resolveTheme,
  themeInitScript,
  type ThemePreference,
} from './theme';

describe('parseThemePreference', () => {
  it('accepts the three preferences and falls back to system', () => {
    expect(parseThemePreference('dark')).toBe('dark');
    expect(parseThemePreference('light')).toBe('light');
    expect(parseThemePreference('system')).toBe('system');
    expect(parseThemePreference('purple')).toBe('system');
    expect(parseThemePreference(null)).toBe('system');
  });
});

describe('resolveTheme', () => {
  it('follows the system only when asked to', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});

describe('themeInitScript', () => {
  function run(stored: string | null | Error, systemDark: boolean) {
    const classes = new Set<string>();
    const style: { colorScheme?: string } = {};
    runInNewContext(themeInitScript, {
      localStorage: {
        getItem(key: string) {
          expect(key).toBe(THEME_STORAGE_KEY);
          if (stored instanceof Error) throw stored;
          return stored;
        },
      },
      window: { matchMedia: () => ({ matches: systemDark }) },
      document: {
        documentElement: {
          style,
          classList: {
            toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)),
          },
        },
      },
    });
    return { dark: classes.has(DARK_CLASS), colorScheme: style.colorScheme };
  }

  it.each<[ThemePreference | null, boolean, boolean]>([
    ['dark', false, true],
    ['light', true, false],
    ['system', true, true],
    ['system', false, false],
    [null, true, true],
  ])('stored %s with system dark=%s → dark=%s', (stored, systemDark, dark) => {
    expect(run(stored, systemDark)).toEqual({ dark, colorScheme: dark ? 'dark' : 'light' });
  });

  it('falls back to the system preference when storage throws', () => {
    expect(run(new Error('SecurityError'), true).dark).toBe(true);
  });
});
