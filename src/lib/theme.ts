/**
 * Colour-scheme preference. Universal and dependency-free: the same constants
 * drive the pre-paint script in the root layout and the client toggle, so the
 * two can never disagree about the storage key or the class name.
 */

export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = 'light' | 'dark';

/** `localStorage` key holding the viewer's preference. */
export const THEME_STORAGE_KEY = 'g2way-dashboard:theme';

/** Class on `<html>` that switches Tailwind's `dark:` variant on. */
export const DARK_CLASS = 'dark';

export function parseThemePreference(value: unknown): ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference)
    ? (value as ThemePreference)
    : 'system';
}

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}

/**
 * Runs in `<head>` before first paint, so a dark-mode viewer never sees a white
 * flash while React hydrates. Kept as a string built from the constants above;
 * storage can throw (private windows, blocked site data), which falls back to
 * the system preference.
 */
export const themeInitScript = `(function(){try{var p=null;try{p=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)})}catch(e){}var d=p==='dark'||(p!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle(${JSON.stringify(
  DARK_CLASS,
)},d);document.documentElement.style.colorScheme=d?'dark':'light'}catch(e){}})();`;
