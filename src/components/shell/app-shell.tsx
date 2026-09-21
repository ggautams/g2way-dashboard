import { Suspense } from 'react';
import { CommandPalette } from './command-palette';
import { DegradedBanner } from './degraded-banner';
import { MobileBar, Sidebar } from './sidebar';
import { Toaster } from './toaster';

/** The chrome around every page. A Server Component; only its interactive parts are client. */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileBar />
        {/* Streams in after the page, so a slow or dead gateway never blocks the render. */}
        <Suspense fallback={null}>
          <DegradedBanner />
        </Suspense>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8 md:py-8">
          {children}
        </main>
      </div>
      <CommandPalette />
      <Toaster />
    </div>
  );
}
