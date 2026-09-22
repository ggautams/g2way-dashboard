'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { bffClient, unwrap } from '@/lib/g2/client';
import { GatewayError } from '@/lib/g2/errors';

/**
 * `POST /g2/reload` through the BFF (audited as `gateway.reload`), for one
 * named environment. On success the page re-renders, which clears the
 * pending-changes bar; a refusal is quoted verbatim.
 */
export function ReloadButton({ environment }: { environment: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    setBusy(true);
    setError(null);
    try {
      await unwrap(bffClient(environment).POST('/g2/reload'));
      router.refresh();
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
      <Button size="sm" onClick={reload} disabled={busy}>
        {busy ? 'Reloading…' : 'Reload gateway'}
      </Button>
      {error && (
        <p role="alert" className="max-w-sm text-right font-mono text-xs break-all text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
