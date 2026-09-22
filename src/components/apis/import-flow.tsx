'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { FormField } from '@/lib/apis/draft';
import { importOpenApi } from '@/lib/apis/import';
import type { ApiDefinition } from '@/lib/apis/list';
import { ApiDesigner } from './api-designer';
import type { DesignerEnvironment } from './save-bar';

type Props = {
  help: Record<FormField, string>;
  schema: { $id: string } & object;
  environment: DesignerEnvironment;
};

/**
 * Paste or choose an OpenAPI/Swagger document, then continue in the designer
 * with the mapped definition as an unsaved draft. Parsing happens in the
 * browser: the document is never uploaded, only the definition saved from it.
 */
export function ImportFlow({ help, schema, environment }: Props) {
  const [source, setSource] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<{ draft: ApiDefinition; notes: string[] } | null>(null);

  if (imported !== null) {
    return (
      <div className="flex flex-col gap-6">
        <section className="rounded-md border border-border bg-subtle p-3 text-sm">
          <p className="font-medium">Imported as an unsaved draft. What the import did:</p>
          <ul className="mt-1 list-disc pl-5 text-xs text-muted">
            {imported.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          <Button variant="link" size="sm" className="px-0" onClick={() => setImported(null)}>
            Import a different document
          </Button>
        </section>
        <ApiDesigner
          original={null}
          initial={imported.draft}
          help={help}
          schema={schema}
          canWrite
          environment={environment}
        />
      </div>
    );
  }

  const convert = () => {
    const result = importOpenApi(source);
    if (!result.ok) return setError(result.error);
    setError(null);
    setImported({ draft: result.draft, notes: result.notes });
  };

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="openapi-file">OpenAPI 3.x or Swagger 2.0 file (JSON or YAML)</Label>
        <input
          id="openapi-file"
          type="file"
          accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml"
          className="text-sm"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (file) setSource(await file.text());
          }}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="openapi-source">…or paste it</Label>
        <Textarea
          id="openapi-source"
          rows={14}
          className="font-mono text-xs"
          value={source}
          onChange={(event) => setSource(event.target.value)}
          placeholder={
            'openapi: 3.0.3\ninfo:\n  title: My API\nservers:\n  - url: https://api.example.com'
          }
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div>
        <Button onClick={convert}>Continue in the designer</Button>
      </div>
    </div>
  );
}
