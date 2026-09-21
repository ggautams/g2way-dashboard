import { AppShell } from '@/components/shell/app-shell';
import { requireUser, toPublicUser } from '@/lib/auth/session';

/**
 * Every signed-in page. Redirects to `/login` (or `/setup` on first run) without
 * a live session. Each page repeats `requireUser()`: layouts are not re-rendered
 * on client navigations, so this check alone would not see a user disabled
 * mid-session (ADR-0004).
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return <AppShell user={toPublicUser(user)}>{children}</AppShell>;
}
