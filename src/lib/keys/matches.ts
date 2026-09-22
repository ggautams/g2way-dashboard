/**
 * "Select every match" on `/keys`: what the browser gets when it asks for the
 * whole match set of the current filter, rather than the rows on screen.
 * Universal and pure; the resolution itself runs server-side
 * (`lib/g2/key-matches.ts`).
 */

import type { KeyListRow } from './list-row';

export type KeyMatchSelection =
  | {
      ok: true;
      environment: string;
      /** Every readable match, in scan order: exactly what a bulk action will send. */
      items: KeyListRow[];
      /** How far the search got (`KeySearchScan` in `lib/g2/keys.ts`). */
      scan: { total: number; scanned: number; matched: number; unchecked: number };
      /** Keys left out because their session could not be read (never selected). */
      unreadable: number;
      /** The cap the search stopped at, when it did: the selection covers only what was read. */
      truncatedAt: number | null;
      /** Why labels and owners were not searched, when they were not. */
      labelsError: string | null;
      /** Unix milliseconds when the match set was resolved. */
      resolvedAt: number;
    }
  | { ok: false; error: string };
