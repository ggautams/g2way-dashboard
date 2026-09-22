import 'server-only';

import { listVersions, type ConfigVersion } from '@/lib/db/config-versions';
import type { Role } from '@/lib/auth/rbac';
import type { ConfigKind } from '@/lib/db/schema/shared';
import { redactFor } from '@/lib/secrets/redact';
import type { DataHandle } from '@/lib/db/users';
import type { HistoryEntry } from './history';

/**
 * The one place stored config versions (ADR-0008) become History tab entries
 * for the browser, for every versioned kind. Version bodies are stored
 * unredacted (ADR-0008 §2); `toHistoryEntry` masks their secrets for a role
 * without the kind's write permission, exactly as the BFF and the page loaders
 * do for the live definition (ADR-0010). No page may call `listVersions`
 * itself; `load-history.test.ts` checks this.
 */
export async function loadHistory(
  handle: DataHandle,
  orgId: string,
  resource: { environment: string; kind: ConfigKind; resourceId: string },
  role: Role,
): Promise<HistoryEntry[]> {
  return (await listVersions(handle, orgId, resource)).map((version) =>
    toHistoryEntry(version, role),
  );
}

/** A stored version as `role` receives it in the browser, secrets masked unless it may write. */
export function toHistoryEntry(version: ConfigVersion, role: Role): HistoryEntry {
  return {
    id: version.id,
    action: version.action,
    definition: redactFor(role, version.kind, version.definition),
    actorEmail: version.actorEmail,
    createdAt: version.createdAt.toISOString(),
  };
}
