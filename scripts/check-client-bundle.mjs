#!/usr/bin/env node
// Proves the gateway admin secret never reaches the browser (CLAUDE.md).
//
// 1. Builds the dashboard with random canary secrets in the environment, then
//    scans every file under .next/static/ — everything the browser can
//    download — for the canaries, the secret variables' names and the admin
//    auth header.
// 2. Starts the built app with each config form (single gateway, named
//    environments) pointed at an unreachable gateway, and fetches every page as
//    HTML and as an RSC payload, failing if a canary appears. That catches a
//    secret passed through props, which no static scan can see.
//
// The static-import guard is src/lib/client-boundary.test.ts; this is the
// backstop over the real build output. Needs no gateway: port 1 refuses.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const NEXT = join(ROOT, 'node_modules', '.bin', 'next');
const STATIC = join(ROOT, '.next', 'static');
const DEAD_GATEWAY = 'http://127.0.0.1:1';

const canary = (name) => `canary-${name}-${randomBytes(12).toString('hex')}`;
const secrets = {
  G2_ADMIN_SECRET: canary('single'),
  G2_ENV_DEV_SECRET: canary('dev'),
  G2_ENV_PROD_SECRET: canary('prod'),
};

const singleForm = {
  G2_ADMIN_URL: DEAD_GATEWAY,
  G2_ADMIN_SECRET: secrets.G2_ADMIN_SECRET,
};
const namedForm = {
  G2_ENVIRONMENTS: 'dev,prod',
  G2_ENV_DEV_URL: DEAD_GATEWAY,
  G2_ENV_DEV_SECRET: secrets.G2_ENV_DEV_SECRET,
  G2_ENV_PROD_URL: DEAD_GATEWAY,
  G2_ENV_PROD_SECRET: secrets.G2_ENV_PROD_SECRET,
};

/** Pages to render, per config form. Every ready nav section belongs here. */
const PAGES = {
  single: ['/', '/gateway'],
  named: ['/', '/gateway', '/gateway?env=prod'],
};

/** Strings no browser-downloadable file may contain. */
const FORBIDDEN_STATIC = [
  ...Object.values(secrets),
  'G2_ADMIN_SECRET',
  /G2_ENV_[A-Z0-9_]*_SECRET/,
  /x-g2-authorization/i,
];

const failures = [];

function run(command, args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`${command} ${args.join(' ')}: exit ${code}`)),
    );
  });
}

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function scanStatic() {
  const files = filesUnder(STATIC);
  for (const file of files) {
    const text = readFileSync(file, 'latin1');
    for (const needle of FORBIDDEN_STATIC) {
      const hit = typeof needle === 'string' ? text.includes(needle) : needle.test(text);
      if (hit) failures.push(`${relative(ROOT, file)} contains ${describe(needle)}`);
    }
  }
  return files.length;
}

/** Names what leaked without printing a canary value. */
function describe(needle) {
  if (typeof needle !== 'string') return String(needle);
  const owner = Object.entries(secrets).find(([, value]) => value === needle);
  return owner ? `the ${owner[0]} canary value` : JSON.stringify(needle);
}

function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePromise(port));
    });
  });
}

async function waitUntilUp(base, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`next start exited with ${child.exitCode}`);
    try {
      await fetch(base, { redirect: 'manual' });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`next start did not come up at ${base}`);
}

async function scanRendered(form, env) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(NEXT, ['start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: ROOT,
    // Only this form's variables: the two forms are mutually exclusive.
    env: { ...withoutG2(process.env), ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    await waitUntilUp(base, child);
    let fetched = 0;
    for (const page of PAGES[form]) {
      for (const [kind, headers] of [
        ['HTML', {}],
        ['RSC', { RSC: '1' }],
      ]) {
        const response = await fetch(base + page, { headers });
        const body = await response.text();
        fetched++;
        if (!response.ok) failures.push(`${form}: ${kind} ${page} answered ${response.status}`);
        for (const value of Object.values(secrets)) {
          if (body.includes(value)) {
            failures.push(`${form}: ${kind} ${page} contains ${describe(value)}`);
          }
        }
      }
    }
    return fetched;
  } finally {
    child.kill('SIGTERM');
  }
}

function withoutG2(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('G2_')));
}

// Every canary is present at build time, so anything inlining env into the
// bundle would inline them. G2_ENVIRONMENTS is left out so the build's own
// prerender pass stays on the single form.
const buildEnv = { ...namedForm, ...singleForm };
delete buildEnv.G2_ENVIRONMENTS;
await run(NEXT, ['build'], { ...withoutG2(process.env), ...buildEnv });

const scanned = scanStatic();
const rendered =
  (await scanRendered('single', singleForm)) + (await scanRendered('named', namedForm));

if (failures.length > 0) {
  console.error('\ncheck:bundle — the admin secret can reach the browser:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `\ncheck:bundle — ok: ${scanned} static files and ${rendered} rendered responses carry no admin secret`,
);
