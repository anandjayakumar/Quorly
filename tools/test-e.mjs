#!/usr/bin/env node
// Regression tests for functions/e.js (M-2). No dependencies; runs on Node 18+.
//
//   node tools/test-e.mjs
//
// The endpoint always answers 204 so it can never be used as an oracle. These tests therefore
// assert on the Analytics Engine write, not on the status line.

// functions/e.js is an ES module for Pages Functions, but the repo has no package.json, so Node
// would treat a .js import as CommonJS. Load the same source through a data: URL instead of
// changing how the Function is deployed.
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../functions/e.js', import.meta.url), 'utf8');
const { onRequest } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) passed++;
  else failed++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail === undefined ? '' : '  ' + detail));
}

const URL_ = 'https://quorly.dev/e';

function analytics() {
  const writes = [];
  return {
    writes,
    binding: { writeDataPoint(point) { writes.push(point); } },
  };
}

// A body that arrives as a stream, so no content-length is attached by the Request constructor.
function streamed(total, chunkSize = 256) {
  const state = { pulls: 0, cancelled: false };
  let sent = 0;
  const body = new ReadableStream({
    pull(controller) {
      state.pulls++;
      if (sent >= total) {
        controller.close();
        return;
      }
      const n = Math.min(chunkSize, total - sent);
      sent += n;
      controller.enqueue(new Uint8Array(n).fill(0x61));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { body, state };
}

function streamRequest(total, chunkSize, headers = {}) {
  const { body, state } = streamed(total, chunkSize);
  const request = new Request(URL_, {
    method: 'POST',
    body,
    duplex: 'half',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8', ...headers },
  });
  return { request, state };
}

async function run(context) {
  const res = await onRequest(context);
  const body = await res.text();
  return { res, body };
}

// --- normal accepted event --------------------------------------------------------
{
  const a = analytics();
  const { res } = await run({
    request: new Request(URL_, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8', Origin: 'https://quorly.dev' },
      body: JSON.stringify({ e: 'export', format: 'pdf', theme: 'dark' }),
    }),
    env: { ANALYTICS: a.binding },
  });
  check('accepts a small same-origin event', res.status === 204 && a.writes.length === 1, 'writes=' + a.writes.length);
  const blobs = a.writes[0] && a.writes[0].blobs;
  check('stores the allowed properties', !!blobs && blobs[1] === 'pdf' && blobs[3] === 'dark', JSON.stringify(blobs));
  check('sets no index other than the event', !!a.writes[0] && a.writes[0].indexes[0] === 'export');
}

// --- allowlist replaces truncation -------------------------------------------------
{
  const a = analytics();
  await run({
    request: new Request(URL_, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ e: 'export', format: 'exe<script>', tool: 'rm -rf', theme: 'purple' }),
    }),
    env: { ANALYTICS: a.binding },
  });
  const blobs = (a.writes[0] || {}).blobs || [];
  check('drops properties outside the allowlist', blobs[1] === '' && blobs[2] === '' && blobs[3] === '', JSON.stringify(blobs));
}

// --- unknown event ------------------------------------------------------------------
{
  const a = analytics();
  await run({
    request: new Request(URL_, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ e: 'smoke-check', format: 'smoke' }),
    }),
    env: { ANALYTICS: a.binding },
  });
  check('drops an unknown event name', a.writes.length === 0, 'writes=' + a.writes.length);
}

// --- declared oversized body --------------------------------------------------------
{
  const a = analytics();
  const { res } = await run({
    request: new Request(URL_, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'Content-Length': '600' },
      body: 'x'.repeat(600),
    }),
    env: { ANALYTICS: a.binding },
  });
  check('rejects an oversized declared body', res.status === 204 && a.writes.length === 0);
}

// --- chunked body with no content-length (the reported bypass) ----------------------
{
  const a = analytics();
  const { request, state } = streamRequest(2000, 256);
  const { res } = await run({ request, env: { ANALYTICS: a.binding } });
  check('caps a chunked body', res.status === 204 && a.writes.length === 0);
  check('cancels the reader early', state.cancelled === true && state.pulls <= 3, 'pulls=' + state.pulls + ' cancelled=' + state.cancelled);
}

// --- stream that lies about a small content-length ---------------------------------
{
  const a = analytics();
  const { request, state } = streamRequest(2000, 128, { 'Content-Length': '10' });
  await run({ request, env: { ANALYTICS: a.binding } });
  check('caps a body that understates content-length', a.writes.length === 0 && state.cancelled === true, 'pulls=' + state.pulls);
}

// --- cross-site origin --------------------------------------------------------------
{
  const a = analytics();
  await run({
    request: new Request(URL_, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8', Origin: 'https://evil.example' },
      body: JSON.stringify({ e: 'export', format: 'md' }),
    }),
    env: { ANALYTICS: a.binding },
  });
  check('drops a cross-origin browser beacon', a.writes.length === 0, 'writes=' + a.writes.length);
}

{
  const a = analytics();
  await run({
    request: new Request(URL_, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'Sec-Fetch-Site': 'cross-site' },
      body: JSON.stringify({ e: 'export', format: 'md' }),
    }),
    env: { ANALYTICS: a.binding },
  });
  check('drops a cross-site fetch metadata request', a.writes.length === 0, 'writes=' + a.writes.length);
}

// --- methods and malformed input ----------------------------------------------------
{
  const { res } = await run({ request: new Request(URL_, { method: 'GET' }), env: {} });
  check('refuses GET with 405 + Allow: POST', res.status === 405 && res.headers.get('allow') === 'POST', 'status=' + res.status);
}

{
  const a = analytics();
  const { res } = await run({
    request: new Request(URL_, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: 'not json',
    }),
    env: { ANALYTICS: a.binding },
  });
  check('fails open on malformed JSON', res.status === 204 && a.writes.length === 0);
}

{
  const a = analytics();
  const { res } = await run({
    request: new Request(URL_, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' } }),
    env: { ANALYTICS: a.binding },
  });
  check('fails open on an empty body', res.status === 204 && a.writes.length === 0);
}

{
  const a = analytics();
  const { res } = await run({
    request: new Request(URL_, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ e: 'first_keystroke' }),
    }),
    env: {},
  });
  check('fails open when the binding is absent', res.status === 204 && a.writes.length === 0);
}

console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exitCode = 1;
