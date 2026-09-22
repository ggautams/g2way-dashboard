'use client';

import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import { jsonDefaults } from 'monaco-editor/languages/features/json/register.js';
import 'monaco-editor/languages/definitions/yaml/register.js';

/**
 * Monaco, bundled with the app instead of fetched from a CDN (the
 * `@monaco-editor/react` default): a self-hosted dashboard may have no internet
 * access, and must not load code from elsewhere. Only the editor core, the JSON
 * language service and YAML highlighting are included. Imported only by the
 * raw editor, which the designer loads lazily and client-side only.
 */

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') {
      return new Worker(new URL('./json.worker.ts', import.meta.url), { type: 'module' });
    }
    return new Worker(new URL('./editor.worker.ts', import.meta.url), { type: 'module' });
  },
};

loader.config({ monaco });

export { jsonDefaults, monaco };
