'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { filterCommands, type Command } from '@/lib/commands';
import type { Permission } from '@/lib/auth/rbac';
import { allSections, sectionAllowed } from '@/lib/nav';
import { THEME_PREFERENCES } from '@/lib/theme';
import { SearchIcon } from './icons';
import { setThemePreference } from './use-theme';

const OPEN_EVENT = 'g2way-dashboard:command-palette';

/** Opens the palette from anywhere, e.g. a search button. */
export function openCommandPalette(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

function useCommands(permissions: readonly Permission[]): Command[] {
  const router = useRouter();
  return useMemo(
    () => [
      ...allSections()
        .filter((section) => section.ready && sectionAllowed(section, permissions))
        .map((section) => ({
          id: `nav:${section.href}`,
          label: section.label,
          group: 'Go to',
          hint: section.description,
          keywords: [...(section.keywords ?? []), section.description],
          run: () => router.push(section.href),
        })),
      ...THEME_PREFERENCES.map((preference) => ({
        id: `theme:${preference}`,
        label: `${preference[0].toUpperCase()}${preference.slice(1)} theme`,
        group: 'Theme',
        keywords: ['appearance', 'mode', 'colour', 'color'],
        run: () => setThemePreference(preference),
      })),
    ],
    [router, permissions],
  );
}

/**
 * ⌘K / Ctrl+K command palette over the navigation registry and shell actions,
 * offering only the sections `permissions` allow (cosmetic, like the sidebar).
 */
export function CommandPalette({ permissions }: { permissions: readonly Permission[] }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const commands = useCommands(permissions);
  const results = filterCommands(commands, query);
  const activeIndex = Math.min(active, results.length - 1);
  const optionId = (index: number) => `${listId}-${index}`;

  useEffect(() => {
    const show = () => {
      setQuery('');
      setActive(0);
      setOpen(true);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (dialogRef.current?.open) setOpen(false);
        else show();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener(OPEN_EVENT, show);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(OPEN_EVENT, show);
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (open && activeIndex >= 0) {
      document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: 'nearest' });
    }
  });

  const run = (command: Command | undefined) => {
    if (!command) return;
    setOpen(false);
    command.run();
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((activeIndex + 1) % Math.max(results.length, 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((activeIndex - 1 + results.length) % Math.max(results.length, 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(results[activeIndex]);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-label="Command palette"
      onClose={() => setOpen(false)}
      onClick={(event) => event.target === event.currentTarget && setOpen(false)}
      className="mx-auto mt-[15vh] w-[min(36rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface p-0 text-foreground shadow-2xl"
    >
      {open && (
        <div>
          <div className="flex items-center gap-2 border-b border-border px-3">
            <SearchIcon className="size-4 shrink-0 text-muted" />
            <input
              autoFocus
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
              placeholder="Type a command or search…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={onInputKeyDown}
              className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted"
            />
            <kbd className="rounded border border-border px-1.5 text-xs text-muted">esc</kbd>
          </div>
          <ul
            id={listId}
            role="listbox"
            aria-label="Commands"
            className="max-h-80 overflow-y-auto p-1"
          >
            {results.map((command, index) => (
              <li
                key={command.id}
                id={optionId(index)}
                role="option"
                aria-selected={index === activeIndex}
                onMouseMove={() => index !== activeIndex && setActive(index)}
                onClick={() => run(command)}
                className={`flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm ${
                  index === activeIndex ? 'bg-subtle' : ''
                }`}
              >
                <span className="font-medium">{command.label}</span>
                {command.hint && <span className="truncate text-muted">{command.hint}</span>}
                <span className="ml-auto shrink-0 text-xs text-muted">{command.group}</span>
              </li>
            ))}
            {results.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-muted">No matching commands</li>
            )}
          </ul>
        </div>
      )}
    </dialog>
  );
}
