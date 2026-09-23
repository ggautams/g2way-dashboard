'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { DrillFocus } from '@/lib/analytics/drill';
import {
  LIVE_POLL_MS,
  livePollUrl,
  liveHref,
  type LiveRequest,
  type LiveSnapshot,
} from '@/lib/analytics/tail';
import { formatAge } from '@/lib/format';

type Selection = { apiId: string | null; focus: DrillFocus | null };

/**
 * The live request inspector's table (ADR-0014). The server renders the first
 * snapshot; this polls `GET /api/analytics/live` every `LIVE_POLL_MS` while
 * live and the tab is visible, and freezes on Pause. A failed poll shows the
 * route's own `{"error"}` message and keeps the last rows.
 *
 * Every value links to the inspector narrowed to it, the way the drill-down's
 * rows do; a new narrowing replaces the current focus, the API is kept. The
 * page keys this component by its selection, so a new selection starts from
 * the server's new first snapshot.
 */
export function LiveTail({
  initial,
  selection,
  showKeys,
}: {
  initial: LiveSnapshot;
  selection: Selection;
  showKeys: boolean;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const url = livePollUrl(selection);

  useEffect(() => {
    if (paused) return;
    const controller = new AbortController();
    const poll = async () => {
      if (inFlight.current || document.hidden) return;
      inFlight.current = true;
      try {
        const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          setError(errorOf(body) ?? `HTTP ${response.status}`);
        } else if (isSnapshot(body)) {
          setSnapshot(body);
          setError(null);
        }
      } catch (caught) {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : 'the request failed');
        }
      } finally {
        inFlight.current = false;
      }
    };
    void poll();
    const timer = setInterval(poll, LIVE_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
      inFlight.current = false;
    };
  }, [paused, url]);

  const narrow = (focus: DrillFocus) => liveHref({ apiId: selection.apiId, focus });
  return (
    <section aria-labelledby="live-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="live-heading" className="text-base font-medium">
          Recent requests
        </h2>
        <Button
          size="sm"
          variant="outline"
          aria-pressed={paused}
          onClick={() => setPaused((was) => !was)}
        >
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <span role="status" className="text-xs text-muted">
          {paused
            ? 'Paused: the list is frozen.'
            : `Live: refreshing every ${LIVE_POLL_MS / 1000} s.`}{' '}
          {snapshot.requests.length} shown.
        </span>
      </div>
      {error !== null && (
        <p role="alert" className="text-sm text-danger">
          Could not refresh: <span className="font-mono text-xs">{error}</span>
        </p>
      )}
      {snapshot.requests.length === 0 ? (
        <p className="text-sm text-muted">No requests in the last 15 minutes match.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-subtle/50 text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Method</th>
                <th className="px-3 py-2 font-medium">Path</th>
                <th className="px-3 py-2 font-medium">API</th>
                {showKeys && <th className="px-3 py-2 font-medium">Key</th>}
                <th className="px-3 py-2 text-right font-medium">Latency</th>
                <th className="px-3 py-2 text-right font-medium">Size</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.requests.map((request) => (
                <Row
                  key={request.id}
                  request={request}
                  now={snapshot.now}
                  showKeys={showKeys}
                  narrow={narrow}
                  apiHref={liveHref({ apiId: request.apiId, focus: selection.focus })}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Row({
  request,
  now,
  showKeys,
  narrow,
  apiHref,
}: {
  request: LiveRequest;
  now: number;
  showKeys: boolean;
  narrow: (focus: DrillFocus) => string;
  apiHref: string;
}) {
  const statusTone =
    request.status >= 500 ? 'text-danger' : request.status >= 400 ? 'text-warning' : '';
  const key = request.key;
  return (
    <tr className="border-t border-border align-top">
      <td className="px-3 py-1.5 whitespace-nowrap text-muted">
        <time dateTime={new Date(request.at).toISOString()}>
          {formatAge(Math.floor(request.at / 1000), now)}
        </time>
      </td>
      <td className={`px-3 py-1.5 font-mono text-xs ${statusTone}`}>
        <Link
          className="hover:underline"
          href={narrow({ dimension: 'status', value: String(request.status) })}
        >
          {request.status}
        </Link>
      </td>
      <td className="px-3 py-1.5 font-mono text-xs">
        <Link
          className="hover:underline"
          href={narrow({ dimension: 'method', value: request.method })}
        >
          {request.method}
        </Link>
      </td>
      <td className="px-3 py-1.5 font-mono text-xs break-all">
        <Link
          className="hover:underline"
          href={narrow({ dimension: 'path', value: request.pathTemplate })}
          title={`Filed as ${request.pathTemplate}`}
        >
          {request.path}
        </Link>
      </td>
      <td className="px-3 py-1.5 font-mono text-xs break-all">
        <Link className="hover:underline" href={apiHref}>
          {request.apiId}
        </Link>
      </td>
      {showKeys && (
        <td className="px-3 py-1.5 text-xs">
          {key === undefined ? null : (
            <Link
              className="hover:underline"
              href={narrow({ dimension: 'key', value: key.hash ?? '' })}
            >
              <span className={key.mono ? 'font-mono' : ''}>{key.label}</span>
              {key.detail !== null && (
                <span className="ml-1 font-mono text-muted">{key.detail}</span>
              )}
            </Link>
          )}
        </td>
      )}
      <td className="px-3 py-1.5 text-right whitespace-nowrap tabular-nums">
        {request.latencyMs} ms
        {request.upstreamLatencyMs !== null && (
          <span className="block text-xs text-muted">upstream {request.upstreamLatencyMs} ms</span>
        )}
      </td>
      <td className="px-3 py-1.5 text-right text-xs whitespace-nowrap text-muted tabular-nums">
        {formatBytes(request.requestBytes)} / {formatBytes(request.responseBytes)}
      </td>
    </tr>
  );
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '–';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function errorOf(body: unknown): string | null {
  return body !== null &&
    typeof body === 'object' &&
    'error' in body &&
    typeof body.error === 'string'
    ? body.error
    : null;
}

function isSnapshot(body: unknown): body is LiveSnapshot {
  return (
    body !== null &&
    typeof body === 'object' &&
    'requests' in body &&
    Array.isArray(body.requests) &&
    'now' in body &&
    typeof body.now === 'number'
  );
}
