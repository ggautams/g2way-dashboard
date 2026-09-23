#!/usr/bin/env node
// Proves the gateway admin secret — and Auth.js's AUTH_SECRET — never reach the
// browser (CLAUDE.md).
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
//    Pages sit behind sign-in, so a scan of what an anonymous fetch gets would
//    only ever see redirects. The run therefore walks the real flow: the first
//    run checks that everything redirects to /setup, then seeds an owner into
//    the throwaway database; every run then checks the anonymous redirects and
//    the BFF's 401, signs in through Auth.js's own credentials endpoint, and
//    requires each page to answer 200 *for that user* before scanning it.
//    It also signs in as a seeded viewer and portal-dev and checks the roles
//    hold server-side (ADR-0005): 403 on forbidden pages and BFF operations.
//    A seeded audit entry gives the audit detail page a concrete id.
//
// The static-import guard is src/lib/client-boundary.test.ts; this is the
// backstop over the real build output. Needs no gateway: port 1 refuses.

import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const NEXT = join(ROOT, 'node_modules', '.bin', 'next');
const STATIC = join(ROOT, '.next', 'static');
const DEAD_GATEWAY = 'http://127.0.0.1:1';
// A non-default org, so the run also proves sign-in follows G2_ORG_ID.
const ORG_ID = 'bundle-check-org';

// A throwaway SQLite database, so the startup migrations (src/instrumentation.ts)
// run for real without touching ./data.
const DB_DIR = mkdtempSync(join(tmpdir(), 'g2dash-bundle-'));
const DB_ENV = { DATABASE_URL: `file:${join(DB_DIR, 'dashboard.db')}` };
process.on('exit', () => rmSync(DB_DIR, { recursive: true, force: true }));

const canary = (name) => `canary-${name}-${randomBytes(12).toString('hex')}`;
const secrets = {
  G2_ADMIN_SECRET: canary('single'),
  G2_ENV_DEV_SECRET: canary('dev'),
  G2_ENV_PROD_SECRET: canary('prod'),
  AUTH_SECRET: canary('auth'),
  // Not a secret, but server-only all the same (ADR-0011): the request
  // console's proxy URL must never reach the browser either.
  G2_PROXY_URL: `http://${canary('proxy')}.invalid:8080`,
};

// Auth.js: the canary secret, and trust the Host header as `next start` requires.
// G2_ORG_ID rides along because every run strips the caller's G2_* variables.
const AUTH_ENV = { AUTH_SECRET: secrets.AUTH_SECRET, AUTH_TRUST_HOST: 'true', G2_ORG_ID: ORG_ID };

// The accounts the scan signs in as. Seeded straight into the throwaway database.
const account = (role, email) => ({
  role,
  email,
  name: `Bundle Check ${role}`,
  password: randomBytes(18).toString('base64url'),
});
const OWNER = account('owner', 'bundle-check@example.com');
const VIEWER = account('viewer', 'bundle-viewer@example.com');
const PORTAL_DEV = account('portal-dev', 'bundle-portal@example.com');

const singleForm = {
  G2_ADMIN_URL: DEAD_GATEWAY,
  G2_ADMIN_SECRET: secrets.G2_ADMIN_SECRET,
  G2_PROXY_URL: secrets.G2_PROXY_URL,
};
const namedForm = {
  G2_ENVIRONMENTS: 'dev,prod',
  G2_ENV_DEV_URL: DEAD_GATEWAY,
  G2_ENV_DEV_SECRET: secrets.G2_ENV_DEV_SECRET,
  G2_ENV_PROD_URL: DEAD_GATEWAY,
  G2_ENV_PROD_SECRET: secrets.G2_ENV_PROD_SECRET,
};

/**
 * Signed-in pages to render, per config form. Every ready nav section belongs
 * here. `/setup` and `/login` are scanned too, signed out, by the flow below.
 */
// A seeded audit entry, so the detail page renders a real before/after diff.
const AUDIT_ENTRY_ID = randomUUID();
const PAGES = {
  single: [
    '/',
    '/gateway',
    '/users',
    '/audit',
    `/audit/${AUDIT_ENTRY_ID}`,
    '/account',
    '/apis',
    '/apis/new',
    '/apis/import',
    '/apis/view/any-api',
  ],
  named: [
    '/',
    '/gateway',
    '/gateway?env=prod',
    '/users',
    '/audit',
    '/audit?action=auth.&outcome=success',
    `/audit/${AUDIT_ENTRY_ID}`,
    '/account',
    '/apis',
    '/apis?q=x&state=inactive&auth=jwt',
    '/apis/new',
    '/apis/import',
    '/apis/view/any-api',
  ],
};

/** Strings no browser-downloadable file may contain. */
const FORBIDDEN_STATIC = [
  ...Object.values(secrets),
  'G2_ADMIN_SECRET',
  'AUTH_SECRET',
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

/**
 * Fetches `path` without following redirects — a followed redirect would scan
 * the login page in place of the one asked for — and fails if any canary is in
 * the body. The one redirect taken is Next's own cache-busting hop for RSC
 * requests (`/x` → `/x?_rsc`), which leads to the same page.
 */
async function fetchAndScan(base, path, label, init = {}) {
  let response = await fetch(base + path, { redirect: 'manual', ...init });
  const location = response.headers.get('location');
  if (location !== null && new URL(location, base).searchParams.has('_rsc')) {
    const target = new URL(location, base);
    if (target.pathname === new URL(path, base).pathname) {
      response = await fetch(target, { redirect: 'manual', ...init });
    }
  }
  const body = await response.text();
  for (const value of Object.values(secrets)) {
    if (body.includes(value)) failures.push(`${label} ${path} contains ${describe(value)}`);
  }
  return { response, body };
}

async function expectRedirect(base, path, to, label) {
  const { response } = await fetchAndScan(base, path, label);
  const location = response.headers.get('location') ?? '';
  if (response.status < 300 || response.status >= 400 || new URL(location, base).pathname !== to) {
    failures.push(
      `${label}: ${path} answered ${response.status} ${location}, expected a redirect to ${to}`,
    );
  }
}

/** Seeds the scan's accounts into the throwaway database: the owner as /setup would. */
async function seedAccounts() {
  const { default: Database } = await import('better-sqlite3');
  // Plain TypeScript with no imports beyond node:crypto; Node strips the types.
  const { hashPassword } = await import('../src/lib/auth/password.ts');
  const db = new Database(DB_ENV.DATABASE_URL.slice('file:'.length));
  try {
    const now = Date.now();
    const insert = db.prepare(
      `insert into users (id, org_id, email, name, password_hash, role, disabled, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    );
    for (const user of [OWNER, VIEWER, PORTAL_DEV]) {
      const hash = await hashPassword(user.password);
      insert.run(randomUUID(), ORG_ID, user.email, user.name, hash, user.role, now, now);
    }
    db.prepare(
      `insert into audit_log (id, org_id, actor_email, actor_role, action, target, before, after,
         gateway_method, gateway_path, gateway_status, environment, outcome, created_at)
       values (?, ?, ?, 'owner', 'api.update', 'httpbin', ?, ?, 'PUT', '/g2/apis/httpbin', 200, 'dev', 'success', ?)`,
    ).run(
      AUDIT_ENTRY_ID,
      ORG_ID,
      OWNER.email,
      JSON.stringify({ api_id: 'httpbin', listen_path: '/old/' }),
      JSON.stringify({ api_id: 'httpbin', listen_path: '/new/' }),
      now,
    );
  } finally {
    db.close();
  }
}

/** Signs in through Auth.js's credentials endpoint; returns the Cookie header to send. */
async function signIn(base, label, user = OWNER) {
  const jar = new Map();
  const keep = (response) => {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const eq = pair.indexOf('=');
      jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  };
  const header = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');

  const csrf = await fetch(`${base}/api/auth/csrf`);
  keep(csrf);
  const { csrfToken } = await csrf.json();
  const callback = await fetch(`${base}/api/auth/callback/credentials`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: header() },
    body: new URLSearchParams({ csrfToken, email: user.email, password: user.password }),
  });
  keep(callback);
  if (![...jar.keys()].some((name) => name.endsWith('authjs.session-token'))) {
    throw new Error(
      `${label}: signing in as the seeded ${user.role} set no session cookie (${callback.status})`,
    );
  }
  return header();
}

async function scanRendered(form, env, { firstRun }) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(NEXT, ['start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: ROOT,
    // Only this form's variables: the two forms are mutually exclusive.
    env: { ...withoutG2(process.env), ...DB_ENV, ...AUTH_ENV, ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    await waitUntilUp(base, child);
    let fetched = 0;
    const anonymous = `${form} (signed out)`;

    if (firstRun) {
      // No users yet: everything leads to /setup, which renders.
      await expectRedirect(base, '/', '/setup', anonymous);
      await expectRedirect(base, '/login', '/setup', anonymous);
      const setup = await fetchAndScan(base, '/setup', anonymous);
      if (setup.response.status !== 200)
        failures.push(`${anonymous}: /setup answered ${setup.response.status}`);
      fetched += 3;
      await seedAccounts();
    }

    // Users exist: pages lead to /login, /setup is gone, and the BFF refuses.
    for (const page of PAGES[form]) await expectRedirect(base, page, '/login', anonymous);
    await expectRedirect(base, '/setup', '/login', anonymous);
    const login = await fetchAndScan(base, '/login', anonymous);
    if (login.response.status !== 200)
      failures.push(`${anonymous}: /login answered ${login.response.status}`);
    const refused = await fetchAndScan(base, '/api/g2/version', anonymous);
    if (refused.response.status !== 401 || !('error' in JSON.parse(refused.body))) {
      failures.push(
        `${anonymous}: BFF answered ${refused.response.status}, expected 401 {"error"}`,
      );
    }
    fetched += PAGES[form].length + 3;

    const cookie = await signIn(base, form);
    const signedIn = `${form} (signed in)`;
    for (const page of PAGES[form]) {
      for (const [kind, headers] of [
        ['HTML', {}],
        ['RSC', { RSC: '1' }],
      ]) {
        const { response, body } = await fetchAndScan(base, page, `${signedIn}: ${kind}`, {
          headers: { ...headers, cookie },
        });
        fetched++;
        if (response.status !== 200) {
          failures.push(`${signedIn}: ${kind} ${page} answered ${response.status}`);
        } else if (!body.includes(OWNER.email)) {
          failures.push(`${signedIn}: ${kind} ${page} did not render the signed-in shell`);
        }
      }
    }
    // Past the session check the BFF tries the (dead) gateway: 502, not 401.
    const proxied = await fetchAndScan(base, '/api/g2/version', signedIn, { headers: { cookie } });
    if (proxied.response.status !== 502) {
      failures.push(
        `${signedIn}: BFF answered ${proxied.response.status}, expected 502 from the dead gateway`,
      );
    }
    fetched++;
    if (firstRun) fetched += await checkRoles(base);
    return fetched;
  } finally {
    child.kill('SIGTERM');
  }
}

/**
 * Roles hold server-side (ADR-0005): a viewer reads but cannot write or open
 * /users, and a portal-dev gets nothing from the gateway at all. Every answer
 * is scanned like any other. Returns how many responses it fetched.
 */
async function checkRoles(base) {
  let fetched = 0;
  const expectStatus = async (who, cookie, path, status, init = {}) => {
    const { response, body } = await fetchAndScan(base, path, who, {
      ...init,
      headers: { ...init.headers, cookie },
    });
    fetched++;
    if (response.status !== status) {
      failures.push(
        `${who}: ${init.method ?? 'GET'} ${path} answered ${response.status}, expected ${status}`,
      );
    } else if (path.startsWith('/api/') && status === 403 && !('error' in JSON.parse(body))) {
      failures.push(`${who}: ${path} 403 was not in the {"error"} envelope`);
    }
  };

  const viewer = await signIn(base, 'viewer', VIEWER);
  await expectStatus('viewer', viewer, '/gateway', 200);
  await expectStatus('viewer', viewer, '/users', 403);
  await expectStatus('viewer', viewer, '/audit', 403);
  await expectStatus('viewer', viewer, '/apis', 200);
  await expectStatus('viewer', viewer, '/apis/view/any-api', 200);
  await expectStatus('viewer', viewer, '/apis/new', 403);
  await expectStatus('viewer', viewer, '/apis/import', 403);
  await expectStatus('viewer', viewer, `/audit/${AUDIT_ENTRY_ID}`, 403);
  // A read reaches the (dead) gateway; a write is refused before it.
  await expectStatus('viewer', viewer, '/api/g2/version', 502);
  await expectStatus('viewer', viewer, '/api/g2/reload', 403, { method: 'POST' });
  // The request console needs apis:test (ADR-0011), refused before any gateway call.
  await expectStatus('viewer', viewer, '/api/g2/console', 403, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiId: 'any-api', method: 'GET', path: '', headers: [], body: '' }),
  });

  const portal = await signIn(base, 'portal-dev', PORTAL_DEV);
  await expectStatus('portal-dev', portal, '/', 200);
  await expectStatus('portal-dev', portal, '/gateway', 403);
  await expectStatus('portal-dev', portal, '/apis', 403);
  await expectStatus('portal-dev', portal, '/api/g2/version', 403);
  return fetched;
}

function withoutG2(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('G2_')));
}

// Every canary is present at build time, so anything inlining env into the
// bundle would inline them. G2_ENVIRONMENTS is left out so the build's own
// prerender pass stays on the single form.
const buildEnv = { ...namedForm, ...singleForm };
delete buildEnv.G2_ENVIRONMENTS;
await run(NEXT, ['build'], { ...withoutG2(process.env), ...DB_ENV, ...AUTH_ENV, ...buildEnv });

const scanned = scanStatic();
const rendered =
  (await scanRendered('single', singleForm, { firstRun: true })) +
  (await scanRendered('named', namedForm, { firstRun: false }));

if (failures.length > 0) {
  console.error('\ncheck:bundle — a secret can reach the browser, or sign-in gating failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `\ncheck:bundle — ok: ${scanned} static files and ${rendered} rendered responses carry no admin or auth secret`,
);
