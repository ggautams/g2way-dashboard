import 'server-only';

import { listVersions, type ConfigVersion } from '@/lib/db/config-versions';
import type { ConfigKind } from '@/lib/db/schema/shared';
import type { DataHandle } from '@/lib/db/users';
import type { HistoryEntry } from './history';

/**
 * The one place stored config versions (ADR-0008) become History tab entries
 * for the browser, for every versioned kind. Version bodies are unredacted
 * (ADR-0008 §2), and today they are passed as they are, to exactly the roles
 * that already see the full definition through the BFF (§6).
 *
 * Redaction seam: when read-only roles stop seeing secrets (ROADMAP M4,
 * "Decide whether read-only roles see secrets"), redact `definition` in
 * `toHistoryEntry`, the same way the BFF redacts its reads. No page may call
 * `listVersions` itself; `load-history.test.ts` checks this.
 */
export async function loadHistory(
  handle: DataHandle,
  orgId: string,
  resource: { environment: string; kind: ConfigKind; resourceId: string },
): Promise<HistoryEntry[]> {
  return (await listVersions(handle, orgId, resource)).map(toHistoryEntry);
}

/** A stored version as the browser receives it. Redaction goes here. */
export function toHistoryEntry(version: ConfigVersion): HistoryEntry {
  return {
    id: version.id,
    action: version.action,
    definition: version.definition,
    actorEmail: version.actorEmail,
    createdAt: version.createdAt.toISOString(),
  };
}
