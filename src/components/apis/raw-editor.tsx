'use client';

import Editor from '@monaco-editor/react';
import { useEffect, useState } from 'react';
import type { RawFormat } from '@/lib/apis/raw';
import { jsonDefaults } from './monaco/setup';

type Props = {
  format: RawFormat;
  value: string;
  onChange: (text: string) => void;
  /** `apiDefinitionSchema()`, for Monaco's inline JSON diagnostics and completion. */
  schema: { $id: string } & object;
  readOnly: boolean;
};

/** Follows the shell's theme toggle, which sets `class="dark"` on `<html>`. */
function useDarkMode(): boolean {
  const [dark, setDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  );
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setDark(root.classList.contains('dark')));
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/**
 * Monaco over the draft's text. In JSON mode Monaco validates and completes
 * against g2way's schema inline; the designer lists schema problems for both
 * formats under the editor.
 */
export default function RawEditor({ format, value, onChange, schema, readOnly }: Props) {
  const dark = useDarkMode();
  useEffect(() => {
    jsonDefaults.setDiagnosticsOptions({
      validate: true,
      enableSchemaRequest: false,
      schemas: [{ uri: schema.$id, fileMatch: ['api-definition.json'], schema }],
    });
  }, [schema]);

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Editor
        height="60vh"
        language={format}
        path={format === 'json' ? 'api-definition.json' : 'api-definition.yaml'}
        value={value}
        theme={dark ? 'vs-dark' : 'vs'}
        onChange={(text) => onChange(text ?? '')}
        loading={<p className="p-4 text-sm text-muted">Loading the editor…</p>}
        options={{
          readOnly,
          minimap: { enabled: false },
          fontSize: 13,
          tabSize: 2,
          scrollBeyondLastLine: false,
          automaticLayout: true,
        }}
      />
    </div>
  );
}
