import { Suspense } from 'react';
import { can, permissionsFor } from '@/lib/auth/rbac';
import type { PublicUser } from '@/lib/auth/session';
import { AccountMenu } from './account-menu';
import { CommandPalette } from './command-palette';
import { DegradedBanner } from './degraded-banner';
import { MobileBar, Sidebar } from './sidebar';
import { Toaster } from './toaster';

/**
 * The chrome around every signed-in page. A Server Component; only its
 * interactive parts are client. `user` is the already-authenticated account.
 */
export function AppShell({ user, children }: { user: PublicUser; children: React.ReactNode }) {
  const permissions = permissionsFor(user.role);
  return (
    <div className="flex min-h-screen">
      <Sidebar account={<AccountMenu user={user} />} permissions={permissions} />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileBar account={<AccountMenu user={user} compact />} />
        {/* Streams in after the page, so a slow or dead gateway never blocks the render.
            Only for roles that may see gateway status at all. */}
        {can(user.role, 'gateway:read') && (
          <Suspense fallback={null}>
            <DegradedBanner />
          </Suspense>
        )}
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8 md:py-8">
          {children}
        </main>
      </div>
      <CommandPalette permissions={permissions} />
      <Toaster />
    </div>
  );
}
