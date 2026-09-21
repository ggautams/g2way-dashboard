'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Permission } from '@/lib/auth/rbac';
import { isActive, navFor } from '@/lib/nav';
import { openCommandPalette } from './command-palette';
import { SearchIcon } from './icons';
import { ThemeToggle } from './theme-toggle';

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
      <span className="grid size-6 place-items-center rounded bg-accent text-xs text-accent-foreground">
        g2
      </span>
      g2way
    </Link>
  );
}

function SearchButton({ compact = false }: { compact?: boolean }) {
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      aria-label="Search commands"
      aria-keyshortcuts="Meta+K Control+K"
      className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm text-muted transition-colors hover:text-foreground"
    >
      <SearchIcon />
      {!compact && (
        <>
          <span className="flex-1 text-left">Search…</span>
          <kbd className="text-xs">⌘K</kbd>
        </>
      )}
    </button>
  );
}

/**
 * Desktop sidebar; below `md` the {@link MobileBar} takes over and the palette is the nav.
 * `account` is the server-rendered user panel with its sign-out action;
 * `permissions` are the signed-in role's, and hide what it cannot use (cosmetic:
 * pages and the BFF enforce them server-side).
 */
export function Sidebar({
  account,
  permissions,
}: {
  account: React.ReactNode;
  permissions: readonly Permission[];
}) {
  const pathname = usePathname();
  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col gap-4 border-r border-border bg-surface p-4 md:flex">
      <Brand />
      <SearchButton />
      <nav aria-label="Main" className="flex flex-1 flex-col gap-4 overflow-y-auto">
        {navFor(permissions).map((group) => (
          <div key={group.label}>
            <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted">
              {group.label}
            </p>
            <ul className="flex flex-col gap-0.5">
              {group.sections.map((section) => (
                <li key={section.href}>
                  {section.ready ? (
                    <Link
                      href={section.href}
                      aria-current={isActive(section.href, pathname) ? 'page' : undefined}
                      className="block rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-subtle aria-[current=page]:bg-subtle aria-[current=page]:font-medium"
                    >
                      {section.label}
                    </Link>
                  ) : (
                    <span
                      aria-disabled="true"
                      title={`Planned for ${section.milestone}`}
                      className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm text-muted opacity-60"
                    >
                      {section.label}
                      <span className="text-[10px]">{section.milestone}</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <ThemeToggle />
      <div className="border-t border-border pt-3">{account}</div>
    </aside>
  );
}

export function MobileBar({ account }: { account: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-40 flex items-center gap-3 border-b border-border bg-surface px-4 py-2 md:hidden">
      <Brand />
      <div className="ml-auto flex items-center gap-2">
        <SearchButton compact />
        <ThemeToggle />
        {account}
      </div>
    </header>
  );
}
