#!/usr/bin/env node
/**
 * Quorly release runner — a commit on `dev` is gated, then previewed; production is promoted by hand.
 *
 *   node tools/release/release.mjs run [--commit <commit>] [--dry-run]
 *   node tools/release/release.mjs launch
 *   node tools/release/release.mjs promote --commit <commit> [--force] [--skip-deploy]
 *   node tools/release/release.mjs prune [--environment preview|production] [--keep N] [--force]
 *   node tools/release/release.mjs verify
 *   node tools/release/release.mjs status
 *
 * `run`      snapshot a commit -> local gate -> deploy preview -> verify the alias -> prune.
 * `launch`   what the post-commit hook calls: spawns `run` detached and returns immediately.
 * `promote`  deploy a commit that already passed the gate to production. Manual only.
 * `prune`    keep the newest N deployments. Preview prunes immediately; production needs --force.
 * `verify`   compare the live site with the SHA-256 manifest recorded at promotion.
 *
 * Both `--commit` forms take any commit-ish — a full SHA, an abbreviation, a branch or HEAD — and
 * resolve it to the full SHA first, so what is gated, deployed, recorded and moved onto `main` is
 * always the same object.
 *
 * The gate is the same suite in both places: smoke.mjs must report every check (the floor is
 * SMOKE_MIN_TOTAL). A failure before the deploy stage deploys nothing. Everything is recorded
 * in .release/ (git-ignored).
 */
import { execSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SELF), '..', '..');
const SMOKE = path.join(REPO, 'smoke.mjs');

const REL = path.join(REPO, '.release');
const RUNS = path.join(REL, 'runs');
const LOCK = path.join(REL, 'run.lock');
const STATUS = path.join(REL, 'status.json');
const HISTORY = path.join(REL, 'history.jsonl');
const PRODUCTION = path.join(REL, 'production.json');

const PROJECT = 'quorly';
const PREVIEW_ALIAS = 'https://preview.quorly.pages.dev';
const PROD_ALIAS = 'https://quorly.dev';

/**
 * The account id is not a secret, but it identifies the owner's Cloudflare account and this
 * repository is public, so it is never stored here. Only the preview prune needs it: `wrangler
 * pages deploy` resolves the project by name, and the gate and promote paths never touch the
 * account endpoint. Resolved lazily, so `run --dry-run`, `status` and CI keep working with no
 * Cloudflare configuration at all.
 */
function pagesApi() {
  const account = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  if (!account) {
    throw new Error(
      'CLOUDFLARE_ACCOUNT_ID is not set. The preview prune calls the Pages REST API and needs the ' +
        'account id; deploying itself does not. Set it in the environment, or run with --dry-run.',
    );
  }
  return `https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/${PROJECT}/deployments`;
}

// Never resolve node/npx through PATH: the hook runs under Git-for-Windows' sh, whose PATH
// differs from a normal shell's. Pin both to the interpreter running this file.
const NODE = `"${process.execPath}"`;
const NPX_BIN = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'npx.cmd' : 'npx');
// M-6: wrangler is pinned exactly in package.json/package-lock.json and installed with `npm ci`.
// Prefer that locked binary. The npx fallback only exists for an environment where `npm ci` has
// not run yet (a fresh clone doing `run --dry-run`); it is no longer the release path.
const LOCAL_WRANGLER = path.join(REPO, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
const WRANGLER = fs.existsSync(LOCAL_WRANGLER)
  ? `"${LOCAL_WRANGLER}"`
  : (fs.existsSync(NPX_BIN) ? `"${NPX_BIN}" --yes wrangler@3.114.17` : 'npx --yes wrangler@3.114.17');
const KEEP_PREVIEWS = 3;
const KEEP_PRODUCTION = 3;
const SMOKE_MIN_TOTAL = 366; // +1 check: CI definitions must never be published (M-7)
const DEV_READY_MS = 150_000;

// ---------------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------------

let LOGFD = null;
let LOGPATH = null;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  process.stdout.write(line + '\n');
  if (LOGFD !== null) {
    try { fs.writeSync(LOGFD, line + '\n'); } catch { /* best effort */ }
  }
}

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run a shell command, tee its output into the log, and never throw unless asked to. */
function sh(cmd, { cwd = REPO, allowFail = false, env = process.env, quiet = false } = {}) {
  if (!quiet) log(`$ ${cmd}`);
  try {
    const out = execSync(cmd, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    if (!quiet && out.trim()) log(out.trim().replace(/^/gm, '    '));
    return { code: 0, out: out.trim() };
  } catch (e) {
    const out = [e.stdout, e.stderr].filter(Boolean).join('\n').toString().trim();
    if (out && !quiet) log(out.replace(/^/gm, '    '));
    if (allowFail) return { code: e.status ?? 1, out };
    throw new Error(`command failed: ${cmd}\n${out.slice(-800)}`);
  }
}

// ---------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------

function gitHead() { return sh('git rev-parse HEAD', { allowFail: false }).out; }
function gitBranch() { return sh('git rev-parse --abbrev-ref HEAD', { allowFail: true }).out || '(detached)'; }
function isDirty() { return sh('git status --porcelain', { allowFail: true }).out.length > 0; }
function gitSubject(sha) { return sh(`git log -1 --format=%s ${sha}`, { allowFail: true, quiet: true }).out.split('\n')[0].trim(); }

/**
 * The full 40-character SHA for a commit-ish argument. Resolving once, here, is what stops the
 * history lookup, `git archive`, the branch move and the production record from disagreeing about
 * the same commit — and it means `--commit 3a1a201` or `--commit dev` is accepted and recorded
 * canonically. Returns null for anything git cannot resolve, so the caller can say so.
 */
function resolveCommit(ref) {
  if (!ref) return null;
  const r = sh(`git rev-parse --verify --quiet "${ref}^{commit}"`, { allowFail: true, quiet: true });
  return r.code === 0 && r.out ? r.out.split('\n')[0].trim() : null;
}

/**
 * Whether two commit strings name the same commit. Exact equality is the normal path; the prefix
 * fallback exists because a history line written by an older build may hold an abbreviation. The
 * seven-character floor is git's own convention for an unambiguous abbreviation.
 */
function sameCommit(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));
}

function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
    else n += 1;
  }
  return n;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual' });
      if (res.status > 0 && res.status < 500) return true;
    } catch { /* not up yet */ }
    await sleep(700);
  }
  return false;
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); }
    catch { /* already gone */ }
    return;
  }
  // POSIX (CI): the dev server is spawned through a shell, so the recorded pid is the shell's
  // and wrangler/workerd hang off it. Signal the pid and its direct children; SIGKILL is a
  // no-op if SIGTERM already did the job.
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    try { process.kill(pid, sig); } catch { /* already gone */ }
    try { execSync(`pkill -${sig} -P ${pid}`, { stdio: 'ignore' }); } catch { /* no children */ }
  }
}

function oauthToken() {
  try {
    const p = path.join(os.homedir(), '.wrangler', 'config', 'default.toml');
    const m = fs.readFileSync(p, 'utf8').match(/oauth_token\s*=\s*"([^"]+)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

function cfAuth() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (token) return { token, mode: 'api-token' };
  const oauth = oauthToken();
  if (oauth) return { token: oauth, mode: 'oauth' };
  return null;
}

// ---------------------------------------------------------------------------------
// status + history
// ---------------------------------------------------------------------------------

function save(status) {
  fs.mkdirSync(REL, { recursive: true });
  fs.writeFileSync(STATUS, JSON.stringify(status, null, 2));
}

function appendHistory(status) {
  const line = {
    runId: status.runId, state: status.state, commit: status.commit, short: status.short,
    branch: status.branch, dryRun: !!status.dryRun, startedAt: status.startedAt,
    finishedAt: status.finishedAt, deploy: status.deploy || null,
    steps: status.steps.map((s) => ({ name: s.name, ok: s.ok, summary: s.summary })),
    error: status.error || null,
  };
  fs.mkdirSync(REL, { recursive: true });
  fs.appendFileSync(HISTORY, JSON.stringify(line) + '\n');
}

function lastPassedRun(sha) {
  try {
    const lines = fs.readFileSync(HISTORY, 'utf8').trim().split('\n').reverse();
    for (const l of lines) {
      const r = JSON.parse(l);
      if (sameCommit(r.commit, sha) && r.state === 'passed' && !r.dryRun) return r;
    }
  } catch { /* no history */ }
  return null;
}

// ---------------------------------------------------------------------------------
// snapshot / gate / deploy
// ---------------------------------------------------------------------------------

/** Extract exactly the tracked files at `sha` into `stage`, honouring export-ignore. */
function snapshot(sha, runDir, stage) {
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  // git takes an absolute path (git understands Windows paths). tar is handed relative names and
  // its own cwd, because under Git-for-Windows' sh the GNU tar on PATH parses "C:\..." as a remote
  // host and dies with "Cannot connect to C: resolve failed".
  const tar = path.join(runDir, 'snapshot.tar');
  sh(`git archive --format=tar -o "${tar}" ${sha}`, { cwd: REPO });
  sh('tar -xf snapshot.tar -C stage', { cwd: runDir });
  fs.rmSync(tar, { force: true });

  // Pages Functions are resolved from the command's working directory, not from the static
  // stage, so a `functions/` directory has to sit beside `stage` — never inside it, where it
  // would be uploaded and served as a static asset. Both `pages dev` and `pages deploy` run
  // with cwd = runDir, which is where wrangler looks. (M-1)
  const fnSrc = path.join(stage, 'functions');
  if (fs.existsSync(fnSrc)) {
    fs.renameSync(fnSrc, path.join(runDir, 'functions'));
  }

  return countFiles(stage);
}

const smokeCmd = (base) => `${NODE} "${SMOKE}" ${base}`;

/** Run smoke.mjs and demand the full suite. Returns a summary string or throws. */
function runSmoke(base, { label, cwd = REPO } = {}) {
  const r = sh(smokeCmd(base), { cwd, allowFail: true });
  const m = r.out.match(/(\d+)\/(\d+) passed/);
  const passed = m ? Number(m[1]) : -1;
  const total = m ? Number(m[2]) : -1;
  const ok = r.code === 0 && total >= SMOKE_MIN_TOTAL && passed === total;
  if (!ok) {
    const tail = r.out.split('\n').filter((l) => l.startsWith('FAIL')).slice(0, 12).join('\n');
    throw new Error(`${label}: expected all of ${SMOKE_MIN_TOTAL}+ checks to pass, got ${passed}/${total}\n${tail || r.out.slice(-400)}`);
  }
  return `${passed}/${total} passed`;
}

/**
 * Deploy a stage that was built from `git archive <sha>`. M-6: tell Cloudflare which commit this
 * artifact came from. The stage is a pristine archive, so `commit_dirty=false` is a fact, not an
 * assertion about the working tree; the message is quoted through JSON so shell metacharacters in
 * a commit subject cannot escape into the command.
 */
function deploy(stage, branch, runDir, meta = {}) {
  const hash = meta.sha ? ` --commit-hash=${meta.sha}` : '';
  const message = meta.message ? ` --commit-message=${JSON.stringify(meta.message)}` : '';
  const r = sh(`${WRANGLER} pages deploy "${stage}" --project-name=${PROJECT} --branch=${branch}${hash}${message} --commit-dirty=false`,
    { cwd: runDir, allowFail: true, env: { ...process.env, CI: '1' } });
  if (r.code !== 0) throw new Error(`deploy to ${branch} failed:\n${r.out.slice(-700)}`);
  const urls = [...r.out.matchAll(/https:\/\/([a-z0-9-]+)\.quorly\.pages\.dev/g)].map((m) => ({ id: m[1], url: m[0] }));
  const deployment = urls.find((u) => u.id !== 'preview' && u.id !== 'main') || urls[0] || null;
  if (!deployment) throw new Error(`could not read the deployment URL from wrangler output:\n${r.out.slice(-700)}`);
  return deployment;
}

/**
 * SHA-256 of every deployed file, keyed by its site path. Written next to the production record so
 * an auditor can compare the live site to the promoted commit without trusting the local log.
 * HTML documents are recorded too, but verification skips them: Cloudflare injects its analytics
 * beacon into the served HTML, so their bytes intentionally differ from the archive.
 */
function hashStage(stage) {
  const files = {};
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else files['/' + rel] = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    }
  };
  walk(stage, '');
  return files;
}

/** Compare recorded production hashes with what quorly.dev actually serves. Read-only. */
async function verifyProduction() {
  const record = readJson(PRODUCTION);
  if (!record || !record.files) throw new Error('no production hash manifest yet — promote a commit first');
  // Pages consumes these as configuration and never serves them. They belong in the
  // manifest (the deploy has to ship them) but there is no live response to compare.
  const pageConfig = new Set(['/_headers', '/_redirects', '/_routes.json', '/.assetsignore']);
  const checked = [];
  const mismatched = [];
  const skipped = [];
  let config = 0;
  for (const [sitePath, expected] of Object.entries(record.files)) {
    if (pageConfig.has(sitePath)) { config += 1; continue; }
    if (/\.html$/i.test(sitePath) || sitePath === '/') { skipped.push(sitePath); continue; }
    const res = await fetch(PROD_ALIAS + sitePath, { headers: { 'Accept-Encoding': 'identity' } });
    if (!res.ok) { mismatched.push(`${sitePath}: HTTP ${res.status}`); continue; }
    const actual = createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex');
    checked.push(sitePath);
    if (actual !== expected) mismatched.push(`${sitePath}: ${actual.slice(0, 12)} != ${expected.slice(0, 12)}`);
  }
  for (const line of mismatched) log('verify: ' + line);
  log(`verify: ${record.short || record.commit} — ${checked.length} checked, ${skipped.length} HTML skipped, ${config} Pages config, ${mismatched.length} mismatched`);
  return mismatched.length === 0;
}

// ---------------------------------------------------------------------------------
// pruning (wrangler v3 has no `pages deployment delete`, so this is the REST API)
// ---------------------------------------------------------------------------------

async function pruneDeployments(environment = 'preview', keep = KEEP_PREVIEWS, { confirm = true } = {}) {
  const auth = cfAuth();
  if (!auth) throw new Error('no Cloudflare credentials for the REST prune');
  const API = pagesApi();
  const res = await fetch(API, { headers: { Authorization: `Bearer ${auth.token}` } });
  const j = await res.json();
  if (!j.success) throw new Error('listing deployments failed: ' + JSON.stringify(j.errors).slice(0, 300));

  const deploys = j.result
    .filter((d) => d.environment === environment)
    .sort((a, b) => new Date(b.created_on) - new Date(a.created_on));
  const doomed = deploys.slice(keep);

  if (!confirm) {
    for (const d of doomed) log(`prune: would delete ${environment} ${d.id} (${d.created_on})`);
    return `${environment}: kept ${Math.min(deploys.length, keep)} of ${deploys.length}, would delete ${doomed.length} (pass --force to delete)`;
  }

  let deleted = 0;
  for (const d of doomed) {
    const del = await fetch(`${API}/${d.id}?force=true`, { method: 'DELETE', headers: { Authorization: `Bearer ${auth.token}` } });
    const body = await del.json().catch(() => ({}));
    if (del.ok && body.success !== false) deleted += 1;
    else log(`prune: could not delete ${d.id} (${del.status})`);
  }
  return `${environment}: kept ${Math.min(deploys.length, keep)} of ${deploys.length}, deleted ${deleted}`;
}

const prunePreviews = (keep = KEEP_PREVIEWS) => pruneDeployments('preview', keep);

// ---------------------------------------------------------------------------------
// `run`
// ---------------------------------------------------------------------------------

async function cmdRun(argv) {
  const dryRun = argv.includes('--dry-run');
  const shaArg = argv.indexOf('--commit');
  const runIdArg = argv.indexOf('--run-id');

  const commitArg = shaArg >= 0 ? argv[shaArg + 1] : null;
  if (shaArg >= 0 && (!commitArg || commitArg.startsWith('-'))) {
    console.error('run --commit needs a commit: a full or abbreviated SHA, a branch, or HEAD.');
    return 1;
  }
  const sha = resolveCommit(commitArg || 'HEAD');
  if (!sha) {
    console.error(`No such commit: ${commitArg}`);
    return 1;
  }
  const short = sha.slice(0, 8);
  const runId = runIdArg >= 0 ? argv[runIdArg + 1] : nowIso().replace(/[:.]/g, '-');

  fs.mkdirSync(RUNS, { recursive: true });
  LOGPATH = path.join(RUNS, `${runId}.log`);
  LOGFD = fs.openSync(LOGPATH, 'a');

  const runDir = path.join(os.tmpdir(), 'quorly-release', runId);
  const stage = path.join(runDir, 'stage');

  const status = {
    state: 'running', runId, commit: sha, short,
    branch: gitBranch(), dirty: isDirty(), dryRun,
    startedAt: nowIso(), finishedAt: null,
    steps: [], deploy: null, production: readJson(PRODUCTION),
    log: LOGPATH, error: null,
  };
  save(status);

  // Reclaim a lock whose process is gone; refuse while one is alive.
  const held = readJson(LOCK);
  if (held && held.pid && held.pid !== process.pid) {
    let alive = false;
    try { process.kill(held.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
    if (alive) {
      log(`busy: run ${held.runId} (pid ${held.pid}) is still in progress`);
      status.state = 'busy';
      status.error = `another run is in progress: ${held.runId}`;
      status.finishedAt = nowIso();
      save(status);
      fs.closeSync(LOGFD);
      return 2;
    }
    log(`stale lock from pid ${held.pid} — reclaiming`);
  }
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, runId, startedAt: nowIso() }));

  let devPid = null;
  let failureCode = 1;
  let cleanupStage = true;

  async function step(name, fn) {
    const t0 = Date.now();
    log(`--- ${name}`);
    try {
      const summary = await fn();
      status.steps.push({ name, ok: true, summary: summary ?? null, ms: Date.now() - t0 });
      save(status);
      log(`--- ${name}: ok${summary ? ` (${summary})` : ''}`);
      return summary;
    } catch (e) {
      const msg = String(e.message || e).slice(0, 600);
      status.steps.push({ name, ok: false, summary: msg, ms: Date.now() - t0 });
      save(status);
      log(`--- ${name}: FAILED — ${msg}`);
      if (name === 'auth') failureCode = 3;
      if (name === 'deploy-preview' || name === 'smoke-preview' || name === 'promote-deploy' || name === 'smoke-production') failureCode = 4;
      throw e;
    }
  }

  try {
    if (dryRun) {
      // --dry-run never talks to Cloudflare, so it must not demand credentials either: CI runs
      // the full local gate (snapshot + dev server + smoke) without a deploy token.
      status.steps.push({ name: 'auth', ok: true, summary: 'skipped (--dry-run)', ms: 0 });
      log('--- auth: skipped (--dry-run)');
    } else {
      await step('auth', () => {
        const auth = cfAuth();
        if (!auth) throw new Error('no credentials: set CLOUDFLARE_API_TOKEN, or run `npx wrangler login`');
        if (auth.mode === 'oauth') {
          status.authWarning = 'using the cached wrangler OAuth token; it can expire. Set CLOUDFLARE_API_TOKEN for unattended runs.';
          return 'cached OAuth token (see authWarning)';
        }
        return 'CLOUDFLARE_API_TOKEN';
      });
    }

    await step('snapshot', () => `${snapshot(sha, runDir, stage)} files from ${short}`);

    await step('dev-server', async () => {
      const port = await freePort();
      devPid = spawn(`${WRANGLER} pages dev "${stage}" --port ${port} --ip 127.0.0.1`,
        { cwd: runDir, shell: true, stdio: ['ignore', LOGFD, LOGFD], windowsHide: true }).pid;
      if (!await waitForHttp(`http://127.0.0.1:${port}/`, DEV_READY_MS)) {
        throw new Error(`wrangler pages dev did not answer on 127.0.0.1:${port} within ${DEV_READY_MS / 1000}s`);
      }
      return `port ${port}`;
    });

    const port = (() => {
      const s = status.steps.find((x) => x.name === 'dev-server');
      const m = s && s.summary && s.summary.match(/port (\d+)/);
      return m ? Number(m[1]) : null;
    })();

    await step('smoke-local', () => runSmoke(`http://127.0.0.1:${port}`, { label: 'local gate' }));

    await step('stop-server', () => { killTree(devPid); devPid = null; return 'stopped'; });

    if (dryRun) {
      status.steps.push({ name: 'deploy-preview', ok: true, summary: 'skipped (--dry-run)', ms: 0 });
      log('--- deploy-preview: skipped (--dry-run)');
    } else {
      await step('deploy-preview', () => {
        const d = deploy(stage, 'preview', runDir, { sha, message: gitSubject(sha) });
        status.deploy = { id: d.id, url: d.url, alias: PREVIEW_ALIAS, branch: 'preview' };
        return d.id;
      });

      await step('smoke-preview', async () => {
        try {
          return runSmoke(PREVIEW_ALIAS, { label: 'alias gate' });
        } catch (e) {
          // The alias can lag the deployment by a beat.
          log('alias gate failed once — retrying in 6s');
          await sleep(6000);
          return runSmoke(PREVIEW_ALIAS, { label: 'alias gate (retry)' });
        }
      });

      await step('prune', () => prunePreviews());
    }

    status.state = 'passed';
  } catch (e) {
    status.state = 'failed';
    status.error = String(e.message || e).slice(0, 1200);
    process.exitCode = failureCode;
    cleanupStage = false;
  } finally {
    try { killTree(devPid); } catch { /* ignore */ }
    status.finishedAt = nowIso();
    save(status);
    appendHistory(status);
    fs.rmSync(LOCK, { force: true });
    if (cleanupStage && status.state === 'passed') fs.rmSync(runDir, { recursive: true, force: true });
    log(`state=${status.state}${status.error ? ` error=${status.error.split('\n')[0]}` : ''}`);
    log(`log: ${LOGPATH}`);
    fs.closeSync(LOGFD);
    LOGFD = null;
  }
  return status.state === 'passed' ? 0 : (process.exitCode || 1);
}

// ---------------------------------------------------------------------------------
// `promote` — production. Manual, never automatic.
// ---------------------------------------------------------------------------------

async function cmdPromote(argv) {
  const shaArg = argv.indexOf('--commit');
  const force = argv.includes('--force');
const skipDeploy = argv.includes('--skip-deploy');
const commitArg = shaArg >= 0 ? argv[shaArg + 1] : null;

  // A usage error must not leave a release record behind, so the commit is checked before the run
  // directory, the log and the lock exist.
  if (shaArg >= 0 && (!commitArg || commitArg.startsWith('-'))) {
    console.error('promote --commit needs a commit: a full or abbreviated SHA, a branch, or HEAD.');
    return 1;
  }
  const sha = resolveCommit(commitArg || 'HEAD');
  if (!sha) {
    console.error(`No such commit: ${commitArg}`);
    return 1;
  }
  const short = sha.slice(0, 8);

  fs.mkdirSync(RUNS, { recursive: true });
  const runId = `promote-${nowIso().replace(/[:.]/g, '-')}`;
  LOGPATH = path.join(RUNS, `${runId}.log`);
  LOGFD = fs.openSync(LOGPATH, 'a');
  const runDir = path.join(os.tmpdir(), 'quorly-release', runId);
  const stage = path.join(runDir, 'stage');

  const passed = lastPassedRun(sha);
  const status = {
    state: 'running', runId, commit: sha, short, action: 'promote',
    branch: gitBranch(), dirty: isDirty(), dryRun: false,
    startedAt: nowIso(), finishedAt: null, steps: [], deploy: null,
    production: readJson(PRODUCTION), log: LOGPATH, error: null,
  };
  save(status);
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, runId, startedAt: nowIso() }));

  async function step(name, fn) {
    const t0 = Date.now();
    log(`--- ${name}`);
    try {
      const summary = await fn();
      status.steps.push({ name, ok: true, summary: summary ?? null, ms: Date.now() - t0 });
      save(status);
      log(`--- ${name}: ok${summary ? ` (${summary})` : ''}`);
      return summary;
    } catch (e) {
      const msg = String(e.message || e).slice(0, 600);
      status.steps.push({ name, ok: false, summary: msg, ms: Date.now() - t0 });
      save(status);
      log(`--- ${name}: FAILED — ${msg}`);
      throw e;
    }
  }

  try {
    await step('gate-record', () => {
      if (passed) return `preview run ${passed.runId} passed this commit`;
      if (force) return 'no passing preview run on record — overridden with --force';
      throw new Error(`${short} has no passing preview run on record. Promote it only from a preview that passed, or pass --force.`);
    });

    await step('auth', () => {
      const auth = cfAuth();
      if (!auth) throw new Error('no credentials for deploy');
      return auth.mode;
    });

    await step('snapshot', () => `${snapshot(sha, runDir, stage)} files from ${short}`);

    await step('promote-deploy', () => {
      if (skipDeploy) {
        const prior = readJson(PRODUCTION);
        if (prior) status.deploy = { id: prior.deployId, url: prior.url, alias: PROD_ALIAS, branch: 'main' };
        return 'skipped (--skip-deploy)';
      }
      const d = deploy(stage, 'main', runDir, { sha, message: gitSubject(sha) });
      status.deploy = { id: d.id, url: d.url, alias: PROD_ALIAS, branch: 'main' };
      return d.id;
    });

    await step('smoke-production', async () => {
      if (skipDeploy) return 'skipped (--skip-deploy)';
      try {
        return runSmoke(PROD_ALIAS, { label: 'production gate' });
      } catch (e) {
        // PROD_ALIAS is a custom domain, so it can still be serving the previous
        // deployment for a beat after the new one lands. Retry once.
        log('production gate failed once - retrying in 6s');
        await sleep(6000);
        return runSmoke(PROD_ALIAS, { label: 'production gate (retry)' });
      }
    });

    await step('mark-main', () => {
      // On a CI runner (or any checkout where `main` is the current branch at `sha`),
      // `git branch -f main` fails with "cannot force update the branch ... used by
      // worktree". The branch is already where it needs to be in that case.
      const head = gitHead();
      if (head !== sha) sh(`git branch -f main ${sha}`);
      // The manifest is computed from the exact stage that was just deployed, so it can be
      // compared with the live site later (`release.mjs verify`).
      const files = hashStage(stage);
      const record = {
        deployId: status.deploy.id,
        url: status.deploy.url,
        commit: sha,
        short,
        message: gitSubject(sha),
        promotedAt: nowIso(),
        files,
      };
      fs.writeFileSync(PRODUCTION, JSON.stringify(record, null, 2));
      status.production = record;
      return `main -> ${short} (${Object.keys(files).length} files hashed)`;
    });

    status.state = 'passed';
  } catch (e) {
    status.state = 'failed';
    status.error = String(e.message || e).slice(0, 1200);
    process.exitCode = 4;
  } finally {
    status.finishedAt = nowIso();
    save(status);
    appendHistory(status);
    fs.rmSync(LOCK, { force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
    log(`state=${status.state}`);
    fs.closeSync(LOGFD);
    LOGFD = null;
  }
  return status.state === 'passed' ? 0 : (process.exitCode || 1);
}

// ---------------------------------------------------------------------------------
// `launch` — the hook's entry point. Returns immediately.
// ---------------------------------------------------------------------------------

function cmdLaunch() {
  fs.mkdirSync(RUNS, { recursive: true });
  const runId = nowIso().replace(/[:.]/g, '-');
  const child = spawn(process.execPath, [SELF, 'run', '--run-id', runId], {
    cwd: REPO,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  fs.writeFileSync(path.join(REL, 'runner.pid'), String(child.pid));
  process.stdout.write(`launched run ${runId} (pid ${child.pid})\n`);
  return 0;
}

// ---------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);

try {
  let code = 0;
  if (cmd === 'run') code = await cmdRun(rest);
  else if (cmd === 'promote') code = await cmdPromote(rest);
  else if (cmd === 'launch') code = cmdLaunch();
  else if (cmd === 'prune') {
    const k = rest.indexOf('--keep');
    const e = rest.indexOf('--environment');
    const environment = e >= 0 ? rest[e + 1] : 'preview';
    if (environment !== 'preview' && environment !== 'production') {
      console.error('prune --environment must be preview or production');
      process.exit(1);
    }
    // Production pruning deletes rollback targets, so it only acts with an explicit --force.
    const confirm = environment === 'preview' || rest.includes('--force');
    const keep = k >= 0 ? Number(rest[k + 1]) : (environment === 'production' ? KEEP_PRODUCTION : KEEP_PREVIEWS);
    console.log(await pruneDeployments(environment, keep, { confirm }));
  } else if (cmd === 'verify') {
    // A missing manifest is an ordinary state before the first promotion, not a crash.
    try {
      const ok = await verifyProduction();
      if (!ok) process.exitCode = 1;
    } catch (e) {
      console.error(String(e.message || e));
      process.exitCode = 1;
    }
  } else if (cmd === 'status') {
    console.log(fs.existsSync(STATUS) ? fs.readFileSync(STATUS, 'utf8') : 'no status yet');
  } else {
    console.log('usage: release.mjs run|launch|promote|prune|verify|status');
  }
  process.exit(code);
} catch (e) {
  console.error(String(e.stack || e));
  process.exit(1);
}
