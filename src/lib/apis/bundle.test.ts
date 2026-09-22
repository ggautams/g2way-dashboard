import { gunzipSync } from 'node:zlib';
import { SECRET_MASK, redactSecrets } from '@/lib/secrets/redact';
import { describe, expect, it } from 'vitest';
import { bundleFiles, fileNameFor, gzip, tar } from './bundle';
import type { ApiDefinition } from './list';
import { parseRaw } from '@/lib/designer/raw';

const apis: ApiDefinition[] = [
  { api_id: 'orders', name: 'Orders', listen_path: '/orders/', target_url: 'http://o' },
  { api_id: 'a/b c', name: 'Odd id', listen_path: '/odd/', target_url: 'http://x' },
  { api_id: 'A_B_C', name: 'Clash', listen_path: '/clash/', target_url: 'http://y' },
];
const when = new Date('2026-09-23T12:00:00Z');

/** A minimal ustar reader: [path, content] for each regular file. */
function untar(bytes: Uint8Array): [string, string][] {
  const decoder = new TextDecoder();
  const files: [string, string][] = [];
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start: number, length: number) =>
      decoder.decode(header.subarray(start, start + length)).replace(/\0[\s\S]*$/, '');
    const size = parseInt(field(124, 12), 8);
    const stored = parseInt(field(148, 8), 8);
    const sum = [...header].reduce((acc, b, i) => acc + (i >= 148 && i < 156 ? 32 : b), 0);
    expect(sum).toBe(stored);
    expect(field(257, 6)).toBe('ustar');
    const body = bytes.subarray(offset + 512, offset + 512 + size);
    files.push([field(0, 100), decoder.decode(body)]);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

describe('fileNameFor', () => {
  it('makes any id a loadable file name, unique even across case', () => {
    const taken = new Set<string>();
    expect(fileNameFor('orders', 'json', taken)).toBe('orders.json');
    expect(fileNameFor('a/b c', 'yaml', taken)).toBe('a_b_c.yaml');
    expect(fileNameFor('A_B_C', 'yaml', taken)).toBe('A_B_C-2.yaml');
    expect(fileNameFor('..hidden', 'json', taken)).toBe('_hidden.json');
  });
});

describe('the --apps-dir bundle', () => {
  it('holds one parseable definition per file under apps/, and a README', async () => {
    for (const format of ['json', 'yaml'] as const) {
      const files = bundleFiles(apis, format, { environment: 'Production', exportedAt: when });
      const unpacked = untar(gunzipSync(await gzip(tar(files, when))));
      expect(unpacked.map(([path]) => path)).toEqual([
        'README.md',
        `apps/orders.${format}`,
        `apps/a_b_c.${format}`,
        `apps/A_B_C-2.${format}`,
      ]);
      expect(unpacked[0][1]).toMatch(/--apps-dir/);
      const defs = unpacked.slice(1).map(([, content]) => parseRaw(content, format));
      expect(defs).toEqual(apis.map((value) => ({ ok: true, value })));
    }
  });

  it('says in the README when the exporting role saw secrets masked (ADR-0010)', () => {
    const readme = (defs: typeof apis) =>
      bundleFiles(defs, 'json', { environment: 'Production', exportedAt: when })[0].content;
    expect(readme(apis)).toContain('exported unredacted');
    const masked = readme(
      apis.map((api) =>
        redactSecrets('api', {
          ...api,
          auth: { mode: 'jwt', signing_method: 'hs256', secret: 's' },
        }),
      ),
    );
    expect(masked).toContain(`Secrets are hidden: they read "${SECRET_MASK}"`);
    expect(masked).not.toContain('exported unredacted');
  });

  it('pads multi-block files and ends with two zero blocks', () => {
    const big = 'x'.repeat(1300);
    const bytes = tar([{ path: 'big.txt', content: big }], when);
    expect(bytes.length).toBe(512 + 1536 + 1024);
    expect(untar(bytes)).toEqual([['big.txt', big]]);
  });
});
