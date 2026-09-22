import { AppShell } from '@/components/shell/app-shell';
import { EnvironmentSwitcher } from '@/components/shell/environment-switcher';
import { requireUser, toPublicUser } from '@/lib/auth/session';
import { selectEnvironmentAction } from '@/lib/g2/environment-actions';
import { RegistryConfigError, getRegistry, listEnvironments } from '@/lib/g2/environments';
import { selectedEnvironmentId } from '@/lib/g2/selected-environment';

/**
 * Every signed-in page. Redirects to `/login` (or `/setup` on first run) without
 * a live session. Each page repeats `requireUser()`: layouts are not re-rendered
 * on client navigations, so this check alone would not see a user disabled
 * mid-session (ADR-0004).
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <AppShell user={toPublicUser(user)} environment={await environmentSwitcher()}>
      {children}
    </AppShell>
  );
}

/**
 * The shell's environment switcher, shown only when there is a choice. A broken
 * registry shows none: the degraded banner and the Overview report that.
 */
async function environmentSwitcher(): Promise<React.ReactNode> {
  try {
    const registry = getRegistry();
    if (registry.environments.length < 2) return null;
    return (
      <EnvironmentSwitcher
        environments={listEnvironments(registry)}
        current={await selectedEnvironmentId(undefined, registry)}
        action={selectEnvironmentAction}
      />
    );
  } catch (error) {
    if (error instanceof RegistryConfigError) return null;
    throw error;
  }
}
