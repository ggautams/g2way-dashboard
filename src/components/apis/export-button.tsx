'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { bundleFiles, gzip, tar } from '@/lib/apis/bundle';
import type { RawFormat } from '@/lib/designer/raw';
import { bffClient, unwrap } from '@/lib/g2/client';
import { GatewayError } from '@/lib/g2/errors';

/**
 * Downloads every definition in the environment as a `--apps-dir` bundle
 * (`.tar.gz`). Built in the browser from `GET /g2/apis` through the BFF, which
 * applies the role and org scoping of any read.
 */
export function ExportButton({ environment }: { environment: { id: string; label: string } }) {
  const [format, setFormat] = useState<RawFormat>('json');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const apis = await unwrap(bffClient(environment.id).GET('/g2/apis'));
      const now = new Date();
      const archive = await gzip(
        tar(bundleFiles(apis, format, { environment: environment.label, exportedAt: now }), now),
      );
      const url = URL.createObjectURL(
        new Blob([archive as BlobPart], { type: 'application/gzip' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `g2way-apis-${environment.id}-${now.toISOString().slice(0, 10)}.tar.gz`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(
        caught instanceof GatewayError
          ? `${caught.message} (HTTP ${caught.status})`
          : caught instanceof Error
            ? caught.message
            : String(caught),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <select
          aria-label="Bundle format"
          value={format}
          onChange={(event) => setFormat(event.target.value as RawFormat)}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="json">JSON</option>
          <option value="yaml">YAML</option>
        </select>
        <Button variant="outline" onClick={download} disabled={busy}>
          {busy ? 'Exporting…' : 'Export bundle'}
        </Button>
      </div>
      {error && (
        <p role="alert" className="max-w-sm text-right font-mono text-xs break-all text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
