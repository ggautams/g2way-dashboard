'use client';

import { THEME_PREFERENCES, type ThemePreference } from '@/lib/theme';
import { MonitorIcon, MoonIcon, SunIcon } from './icons';
import { setThemePreference, useThemePreference } from './use-theme';

const ICONS: Record<ThemePreference, typeof SunIcon> = {
  system: MonitorIcon,
  light: SunIcon,
  dark: MoonIcon,
};

export function ThemeToggle() {
  const current = useThemePreference();
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="flex rounded-md border border-border p-0.5"
    >
      {THEME_PREFERENCES.map((preference) => {
        const Icon = ICONS[preference];
        const checked = preference === current;
        return (
          <button
            key={preference}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={`${preference} theme`}
            title={`${preference[0].toUpperCase()}${preference.slice(1)} theme`}
            onClick={() => setThemePreference(preference)}
            className={`rounded p-1.5 transition-colors ${
              checked ? 'bg-subtle text-foreground' : 'text-muted hover:text-foreground'
            }`}
          >
            <Icon />
          </button>
        );
      })}
    </div>
  );
}
