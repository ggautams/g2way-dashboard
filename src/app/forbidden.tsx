import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Forbidden' };

/**
 * Rendered with a 403 when a page's `requirePermission()` refuses the signed-in
 * user's role (ADR-0005). Outside the shell: it renders in the root layout.
 */
export default function Forbidden() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-3 px-4">
      <h1 className="text-xl font-semibold tracking-tight">Forbidden</h1>
      <p className="text-sm text-muted">
        Your role does not include access to this page. An owner or admin can change your role on
        the Users page.
      </p>
      <Link href="/" className="text-sm text-accent underline">
        Back to the overview
      </Link>
    </main>
  );
}
