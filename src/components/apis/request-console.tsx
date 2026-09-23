'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { DesignerEnvironment } from '@/components/designer/save-bar';
import { chainAnchor } from '@/lib/apis/chain';
import {
  CONSOLE_MAX_RESPONSE_BYTES,
  CONSOLE_METHODS,
  parseHeaderText,
  postConsoleRequest,
  type ConsoleMethod,
  type ConsoleResult,
} from '@/lib/apis/console';
import { TRACE_LIMITS, type Trace, type TraceStep, type TraceVerdict } from '@/lib/apis/trace';

/** Where the console can send, decided on the server (ADR-0011). */
export type ConsoleAccess = {
  /** The role holds `apis:test`. */
  canSend: boolean;
  /** The environment has a proxy URL (the URL itself never reaches the browser). */
  configured: boolean;
};

type Props = {
  apiId: string;
  /** The stored listen path: the console always tests the stored definition. */
  listenPath: string;
  /** The stored definition's version names, or `null` when it is not versioned. */
  versions: string[] | null;
  environment: DesignerEnvironment;
  access: ConsoleAccess;
  /** The draft differs from the stored definition. */
  dirty: boolean;
};

const NO_VERSION = '__default__';

const VERDICT_LABEL: Record<TraceVerdict, string> = {
  rejected: 'rejected',
  answered: 'answered',
  possible: 'possibly rejected',
  acted: 'acted',
  passed: 'passed',
  skipped: 'skipped',
  unknown: 'unknown',
  off: 'off',
  'not-reached': 'not reached',
};

function verdictVariant(
  verdict: TraceVerdict,
): 'default' | 'secondary' | 'outline' | 'destructive' {
  switch (verdict) {
    case 'rejected':
      return 'destructive';
    case 'answered':
    case 'acted':
      return 'default';
    case 'possible':
    case 'unknown':
      return 'outline';
    default:
      return 'secondary';
  }
}

function statusTone(status: number): string {
  if (status >= 500) return 'text-danger';
  if (status >= 400) return 'text-warning';
  return 'text-success';
}

function Step({ step }: { step: TraceStep }) {
  const dim = step.verdict === 'off' || step.verdict === 'not-reached';
  return (
    <li
      data-verdict={step.verdict}
      className={`rounded-md border border-border px-3 py-2 ${dim ? 'opacity-60' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{step.title}</span>
        {step.version !== undefined && (
          <span className="font-mono text-xs text-muted">{step.version}</span>
        )}
        <Badge variant={verdictVariant(step.verdict)}>{VERDICT_LABEL[step.verdict]}</Badge>
        <a
          href={`#${chainAnchor(step.id, step.version)}`}
          className="ml-auto text-xs text-accent hover:underline"
        >
          In chain
        </a>
      </div>
      {!dim && <p className="mt-1 text-xs text-muted">{step.detail}</p>}
    </li>
  );
}

function TraceView({ trace }: { trace: Trace }) {
  return (
    <section aria-label="Inferred middleware trace" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Middleware trace</h3>
        <Badge variant="outline">inferred by the dashboard</Badge>
      </div>
      <p className="text-sm">{trace.summary}</p>
      {trace.version !== null && (
        <p className="text-xs text-muted">
          Version: <span className="font-mono">{trace.version.name ?? '(none)'}</span> (
          {trace.version.source}
          ).
        </p>
      )}
      {trace.mismatches.length > 0 && (
        <div className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs">
          <p className="font-medium">The response contradicts the stored definition:</p>
          <ul className="ml-4 list-disc">
            {trace.mismatches.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          <p className="mt-1 text-muted">
            The gateway may not have reloaded the stored definition yet, or a pattern matches
            differently in g2way&apos;s Rust regex engine.
          </p>
        </div>
      )}
      <ol className="flex flex-col gap-1">
        {trace.steps.map((step) => (
          <Step key={`${step.version ?? ''}:${step.id}`} step={step} />
        ))}
      </ol>
      <details className="text-xs text-muted">
        <summary className="cursor-pointer text-accent">
          What this trace can and cannot know
        </summary>
        <ul className="mt-1 ml-4 list-disc">
          {TRACE_LIMITS.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function Result({ result }: { result: ConsoleResult }) {
  if (!result.ok) {
    return (
      <section role="alert" className="rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm">
        <p className="mb-1 font-medium text-danger">The test request failed</p>
        <p className="font-mono text-xs break-all">
          {result.error}
          {result.status !== undefined && ` (HTTP ${result.status})`}
        </p>
      </section>
    );
  }
  const { response, sent, timing } = result;
  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Response" className="flex flex-col gap-2">
        <p className="flex flex-wrap items-baseline gap-x-3 text-sm">
          <span className={`font-mono text-base font-semibold ${statusTone(response.status)}`}>
            {response.status} {response.statusText}
          </span>
          <span className="font-mono text-xs text-muted">
            {sent.method} {sent.path}
            {sent.query && `?${sent.query}`}
          </span>
          <span className="text-xs text-muted">
            headers {timing.headersMs} ms · total {timing.totalMs} ms ·{' '}
            {response.truncated ? `over ${CONSOLE_MAX_RESPONSE_BYTES}` : response.bytes} bytes
          </span>
        </p>
        {response.gatewayError !== null && (
          <p className="rounded-md border border-border bg-subtle px-3 py-2 text-sm">
            g2way said: <span className="font-mono">{response.gatewayError}</span>
          </p>
        )}
        <details>
          <summary className="cursor-pointer text-xs text-accent">
            Response headers ({response.headers.length})
          </summary>
          <table className="mt-1 w-full text-xs">
            <tbody>
              {response.headers.map(([name, value], index) => (
                <tr key={`${name}-${index}`} className="align-top">
                  <td className="py-0.5 pr-3 font-mono whitespace-nowrap text-muted">{name}</td>
                  <td className="py-0.5 font-mono break-all">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
        {response.binary ? (
          <p className="text-xs text-muted">A binary body ({response.bytes} bytes); not shown.</p>
        ) : response.body !== '' ? (
          <pre className="max-h-96 overflow-auto rounded-md border border-border bg-subtle p-3 font-mono text-xs whitespace-pre-wrap break-all">
            {response.body}
          </pre>
        ) : (
          <p className="text-xs text-muted">No body.</p>
        )}
        {response.truncated && (
          <p className="text-xs text-muted">
            Only the first {CONSOLE_MAX_RESPONSE_BYTES} bytes were read; the rest was dropped.
          </p>
        )}
      </section>
      <TraceView trace={result.trace} />
    </div>
  );
}

/**
 * The request console (ADR-0011): sends one test request through the
 * environment's proxy listener to the stored API, via the BFF, and shows the
 * response with an inferred middleware trace whose steps link to the Chain
 * tab. Header values and the body are held in this component only; the BFF
 * sends them and never records them.
 */
export function RequestConsole({ apiId, listenPath, versions, environment, access, dirty }: Props) {
  const [method, setMethod] = useState<ConsoleMethod>('GET');
  const [path, setPath] = useState('');
  const [headerText, setHeaderText] = useState('');
  const [body, setBody] = useState('');
  const [version, setVersion] = useState(NO_VERSION);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<ConsoleResult | null>(null);

  if (!access.canSend) {
    return (
      <p className="rounded-md border border-border bg-subtle px-3 py-2 text-sm text-muted">
        Your role cannot send test requests. The console sends real traffic to the upstream, so it
        needs the <span className="font-mono">apis:test</span> permission (editor and up).
      </p>
    );
  }
  if (!access.configured) {
    return (
      <p className="rounded-md border border-border bg-subtle px-3 py-2 text-sm">
        The request console is not configured for {environment.label}. Set the gateway&apos;s proxy
        URL on the dashboard server: <span className="font-mono">G2_PROXY_URL</span>, or{' '}
        <span className="font-mono">G2_ENV_&lt;ID&gt;_PROXY_URL</span> per environment (see{' '}
        <span className="font-mono">.env.example</span>).
      </p>
    );
  }

  const headers = parseHeaderText(headerText);
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const send = async () => {
    if (!headers.ok) return;
    setSending(true);
    setResult(
      await postConsoleRequest(environment.id, {
        apiId,
        method,
        path,
        headers: headers.value,
        body: hasBody ? body : '',
        version: version === NO_VERSION ? null : version,
      }),
    );
    setSending(false);
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        Sends a real request through {environment.label}&apos;s gateway to this API&apos;s upstream.
        The gateway serves what it has loaded: the stored definition, once reloaded.
        {dirty && ' Your unsaved edits are not part of it.'} Header values and the body are sent,
        never recorded; the audit log keeps the method, path and status.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="console-method">Method</Label>
          <Select value={method} onValueChange={(next) => setMethod(next as ConsoleMethod)}>
            <SelectTrigger id="console-method" className="w-28 font-mono">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONSOLE_METHODS.map((m) => (
                <SelectItem key={m} value={m} className="font-mono">
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex min-w-64 flex-1 flex-col gap-1">
          <Label htmlFor="console-path">Path</Label>
          <div className="flex items-center gap-1">
            <span className="font-mono text-sm text-muted">{listenPath}</span>
            <Input
              id="console-path"
              className="font-mono"
              placeholder="users/42?full=1"
              value={path}
              onChange={(event) => setPath(event.target.value)}
            />
          </div>
        </div>
        {versions !== null && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="console-version">Version</Label>
            <Select value={version} onValueChange={setVersion}>
              <SelectTrigger id="console-version" className="w-40 font-mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_VERSION}>none (default)</SelectItem>
                {versions.map((name) => (
                  <SelectItem key={name} value={name} className="font-mono">
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <Button onClick={send} disabled={sending || !headers.ok}>
          {sending ? 'Sending…' : 'Send'}
        </Button>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="console-headers">Headers</Label>
          <Textarea
            id="console-headers"
            className="font-mono text-xs"
            rows={4}
            placeholder={'Authorization: <key>\nAccept: application/json'}
            value={headerText}
            onChange={(event) => setHeaderText(event.target.value)}
            aria-invalid={!headers.ok}
            spellCheck={false}
            autoComplete="off"
          />
          {!headers.ok && <p className="text-xs text-danger">{headers.error}</p>}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="console-body">Body</Label>
          <Textarea
            id="console-body"
            className="font-mono text-xs"
            rows={4}
            disabled={!hasBody}
            placeholder={hasBody ? '{"name": "Ada"}' : `${method} requests carry no body`}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            spellCheck={false}
          />
        </div>
      </div>
      {result !== null && <Result result={result} />}
    </div>
  );
}
