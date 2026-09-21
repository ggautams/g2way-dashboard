'use client';

import { useEffect, useSyncExternalStore } from 'react';
import {
  DARK_CLASS,
  THEME_STORAGE_KEY,
  parseThemePreference,
  resolveTheme,
  type ThemePreference,
} from '@/lib/theme';

const CHANGE_EVENT = 'g2way-dashboard:theme-change';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function subscribe(onChange: () => void): () => void {
  // `storage` keeps other tabs in step; the custom event covers this one.
  window.addEventListener('storage', onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

function getSnapshot(): ThemePreference {
  try {
    return parseThemePreference(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

const getServerSnapshot = (): ThemePreference => 'system';

function applyTheme(preference: ThemePreference): void {
  const dark = resolveTheme(preference, window.matchMedia(DARK_QUERY).matches) === 'dark';
  document.documentElement.classList.toggle(DARK_CLASS, dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage unavailable: the choice still applies for this page view.
  }
  applyTheme(preference);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** The viewer's stored preference, kept applied to `<html>` — including OS switches while on `system`. */
export function useThemePreference(): ThemePreference {
  const preference = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => {
    applyTheme(preference);
    if (preference !== 'system') return;
    const media = window.matchMedia(DARK_QUERY);
    const onChange = () => applyTheme('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preference]);
  return preference;
}
