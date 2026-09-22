/**
 * A definition bundle for g2way's file mode (`--apps-dir`, GitOps): one
 * definition per file, as g2way's loader reads them (`*.json`, `*.yaml` or
 * `*.yml`, one `ApiDefinition` each, flat directory:
 * `crates/g2-core/src/loader.rs`), packed as a `.tar.gz`. Universal and
 * dependency-free: the browser builds it from what the BFF lists, so the
 * export needs no server endpoint of its own.
 */

import type { ApiDefinition } from './list';
import { serialize, type RawFormat } from './raw';

export type BundleFile = { path: string; content: string };

/** A file name g2way's loader will pick up, from an id that may hold anything. */
export function fileNameFor(apiId: string, format: RawFormat, taken: Set<string>): string {
  const stem =
    apiId
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/^\.+/, '_')
      .slice(0, 80) || 'api';
  let name = `${stem}.${format}`;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem}-${n}.${format}`;
  taken.add(name.toLowerCase());
  return name;
}

/** The files of a bundle: `apps/<id>.<format>` per definition, and a README. */
export function bundleFiles(
  apis: readonly ApiDefinition[],
  format: RawFormat,
  { environment, exportedAt }: { environment: string; exportedAt: Date },
): BundleFile[] {
  const taken = new Set<string>();
  const files = apis.map((api) => ({
    path: `apps/${fileNameFor(api.api_id, format, taken)}`,
    content: serialize(api, format),
  }));
  const readme = [
    `# g2way API definitions — ${environment}`,
    '',
    `Exported from g2way-dashboard at ${exportedAt.toISOString()}: ${apis.length} definition(s),`,
    'as stored in the gateway at that moment (including any change not yet reloaded).',
    '',
    'Serve them with `g2way --apps-dir ./apps`. g2way refuses to load two definitions with',
    'the same api_id or listen_path, across files and storage alike, so load these into a',
    'gateway whose storage does not already hold the same APIs.',
    '',
    'Definitions are exported unredacted: they may contain secrets (JWT keys, basic-auth',
    'hashes). Treat this archive like the gateway configuration it is.',
    '',
  ].join('\n');
  return [{ path: 'README.md', content: readme }, ...files];
}

const BLOCK = 512;
const encoder = new TextEncoder();

function writeString(target: Uint8Array, offset: number, length: number, value: string) {
  target.set(encoder.encode(value).subarray(0, length), offset);
}

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

/** A POSIX ustar archive of regular files, all readable, owned by nobody in particular. */
export function tar(files: readonly BundleFile[], mtime: Date): Uint8Array {
  const parts: Uint8Array[] = [];
  const seconds = Math.floor(mtime.getTime() / 1000);
  for (const file of files) {
    const body = encoder.encode(file.content);
    if (encoder.encode(file.path).length > 100) throw new Error(`path too long: ${file.path}`);
    const header = new Uint8Array(BLOCK);
    writeString(header, 0, 100, file.path);
    writeString(header, 100, 8, octal(0o644, 8));
    writeString(header, 108, 8, octal(0, 8));
    writeString(header, 116, 8, octal(0, 8));
    writeString(header, 124, 12, octal(body.length, 12));
    writeString(header, 136, 12, octal(seconds, 12));
    writeString(header, 148, 8, '        '); // checksum placeholder: eight spaces
    writeString(header, 156, 1, '0');
    writeString(header, 257, 6, 'ustar\0');
    writeString(header, 263, 2, '00');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
    parts.push(header, body, new Uint8Array((BLOCK - (body.length % BLOCK)) % BLOCK));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Gzip with the platform's `CompressionStream` (browsers and Node alike). */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
