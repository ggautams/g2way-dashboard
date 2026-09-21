/** Small display formatters. Universal and pure, so pages and tests share them. */

const UNITS: readonly [label: string, seconds: number][] = [
  ['d', 86_400],
  ['h', 3_600],
  ['m', 60],
  ['s', 1],
];

/** A duration as its two largest units: `3d 4h`, `5m 12s`, `0s`. */
export function formatDuration(totalSeconds: number): string {
  let rest = Math.max(0, Math.floor(totalSeconds));
  const parts: string[] = [];
  for (const [label, size] of UNITS) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n > 0 || parts.length > 0) parts.push(`${n}${label}`);
    if (parts.length === 2) break;
  }
  return parts.length === 0 ? '0s' : parts.filter((p) => !p.startsWith('0')).join(' ');
}

/** How long before `nowMs` a Unix-seconds timestamp was: `12s ago`, `3h 2m ago`. */
export function formatAge(unixSecs: number, nowMs: number): string {
  const seconds = Math.floor(nowMs / 1000) - unixSecs;
  // Clock skew between the gateway and the dashboard can put it slightly ahead.
  return seconds <= 0 ? 'just now' : `${formatDuration(seconds)} ago`;
}
