// Conformance environment: frozen Lykia backend + its own fake providers, fake CDN, fake S3, throwaway mongod.
// Ports 7821 (API), 7822 (fake chat providers), 7823 (media proxy), 7824 (CDN), 7825 (S3), 7826 (control), 27221 (mongod).
// Never reads any .env; every variable is given here. Stops everything on SIGTERM/SIGINT or POST :7826/stop.
//
//   LYKIA_BACKEND_DIR=/path/to/lykia-backend LYKIA_CONFORMANCE_WORK=/tmp/some-dir node scripts/conformance/backend-env.mjs
//
// LYKIA_BACKEND_DIR: a backend checkout with node_modules (read only). LYKIA_CONFORMANCE_WORK: where the throwaway
// mongod data, the backend cwd and `env.json` (the API key, mode 0600) go; it is wiped on start. Default: os.tmpdir().
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const F = process.env.LYKIA_BACKEND_DIR;
if (!F) { console.error('[env] set LYKIA_BACKEND_DIR to a lykia-backend checkout'); process.exit(2); }
const HERE = process.env.LYKIA_CONFORMANCE_WORK || path.join(os.tmpdir(), 'lykia-conformance');
const WORK = path.join(HERE, 'work');
const require = createRequire(path.join(F, 'package.json'));
const { MongoClient } = require('mongodb');
const { createFakeProviders } = require(path.join(F, 'tests/fakes/providers.cjs'));
const { createRecraftFake } = require(path.join(F, 'tests/fakes/media/recraft.cjs'));
const { createElevenLabsFake } = require(path.join(F, 'tests/fakes/media/elevenlabs.cjs'));
const { createFakeBytedance, KEY: BYTEDANCE_KEY } = require(path.join(F, 'tests/fakes/media/bytedance.cjs'));

const DB_PORT = 27221, API_PORT = 7821, GW_PORT = 7822, MEDIA_PORT = 7823, CDN_PORT = 7824, S3_PORT = 7825, CTL_PORT = 7826;
const API = `http://127.0.0.1:${API_PORT}`;
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'db'), { recursive: true });
fs.mkdirSync(path.join(WORK, 'cwd'), { recursive: true });
const children = [];
const log = (...a) => console.error('[env]', ...a);

const env = {
  PATH: process.env.PATH, HOME: WORK,
  DATABASE: `mongodb://127.0.0.1:${DB_PORT}`, DB_NAME: 'lykia_conf', PORT: String(API_PORT), APP_ENV: 'local', TZ: 'Europe/Istanbul',
  JWT_SECRET: 'conf-jwt-secret-0123456789abcdef0123456789', ENCRYPTION_KEY: 'conf-encryption-key-0123456789abcdef',
  API_KEY_PEPPER: 'conf-pepper-0123456789abcdef0123456789',
  BACKEND_URL: API, FRONTEND_URL: 'http://localhost:5281', PROJECT_NAME: 'Lykia', TRUST_PROXY_HOPS: '1',
  TS_NODE_TRANSPILE_ONLY: '1', TS_NODE_PROJECT: path.join(F, 'tsconfig.json'),
  PROVIDER_BASE_URL_OVERRIDES: [
    `together=http://127.0.0.1:${GW_PORT}/together/v1`,
    `recraft=http://127.0.0.1:${MEDIA_PORT}/recraft/v1`,
    `elevenlabs=http://127.0.0.1:${MEDIA_PORT}/elevenlabs`,
    `bytedance=http://127.0.0.1:${MEDIA_PORT}/bytedance/api/v3`,
  ].join(','),
  MEDIA_FETCH_HOST_OVERRIDES: `*=http://127.0.0.1:${CDN_PORT}/cdn`,
  S3_ENDPOINT: `http://127.0.0.1:${S3_PORT}`, S3_REGION: 'us-east-1', S3_ACCESS_KEY_ID: 'AKIDCONFSTORAGE00001',
  S3_SECRET_ACCESS_KEY: 'conf-storage-SECRET-0123456789abcdefghij', S3_BUCKET_PUBLIC: 'lykia-conf-public', S3_BUCKET_PRIVATE: 'lykia-conf-private',
  S3_PUBLIC_URL: 'https://lykia-conf-public.edge.example.test',
};

function start(cmd, args, name, extraEnv = {}) {
  const out = fs.openSync(path.join(WORK, `${name}.log`), 'a');
  const p = spawn(cmd, args, { cwd: path.join(WORK, 'cwd'), env: { ...env, ...extraEnv }, stdio: ['ignore', out, out] });
  children.push(p);
  return p;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHttp(url, ms) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`timeout waiting for ${url}`);
    await sleep(500);
  }
}
let stopping = false;
async function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children.reverse()) c.kill('SIGTERM');
  await sleep(1500);
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  for (const s of servers) {
    s.closeAllConnections?.();
    s.close();
  }
  process.exit(code);
}
process.on('SIGTERM', () => void stopAll());
process.on('SIGINT', () => void stopAll());
const servers = [];

// 1. mongod (standalone; the code supports it, docs/DEPLOY.md §0)
start('mongod', ['--dbpath', path.join(WORK, 'db'), '--port', String(DB_PORT), '--bind_ip', '127.0.0.1', '--quiet'], 'mongod');
const mongo = new MongoClient(`mongodb://127.0.0.1:${DB_PORT}`);
for (let i = 0; ; i++) {
  try { await mongo.connect(); break; } catch (e) { if (i > 60) throw e; await sleep(500); }
}
const db = mongo.db('lykia_conf');

// 2. fakes
const gw = createFakeProviders();
await gw.listen(GW_PORT);
const recraft = await createRecraftFake().start();
const eleven = await createElevenLabsFake().start();
const bytedance = await createFakeBytedance();
const routes = { recraft: recraft.url, elevenlabs: eleven.url, bytedance: bytedance.url };
const proxy = http.createServer((req, res) => {
  const m = /^\/([a-z0-9-]+)(\/.*)?$/.exec(req.url || '/');
  const target = m && routes[m[1]];
  if (!target) { res.writeHead(404); res.end(); return; }
  const u = new URL(target);
  const up = http.request({ host: u.hostname, port: u.port, method: req.method, path: m[2] || '/', headers: { ...req.headers, host: u.host } }, (r) => {
    if (!/json/.test(String(r.headers['content-type'] || ''))) { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); return; }
    const parts = [];
    r.on('data', (c) => parts.push(c));
    r.on('end', () => {
      const body = Buffer.concat(parts).toString('utf8').split(target).join(`http://127.0.0.1:${MEDIA_PORT}/${m[1]}`);
      const h = { ...r.headers }; delete h['content-length'];
      res.writeHead(r.statusCode || 502, h); res.end(body);
    });
  });
  up.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(up);
});
await new Promise((r) => proxy.listen(MEDIA_PORT, '127.0.0.1', r)); servers.push(proxy);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42CONF-VIDEO-BYTES-0123456789')]);
const cdn = http.createServer((req, res) => {
  if (/\.mp4(\?|$)/.test(req.url || '')) { res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.end(MP4); return; }
  res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG);
});
await new Promise((r) => cdn.listen(CDN_PORT, '127.0.0.1', r)); servers.push(cdn);
const objects = new Map();
const s3 = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const id = u.pathname.split('/').filter(Boolean).map(decodeURIComponent).join('/');
    if (req.method === 'PUT') { objects.set(id, { body: Buffer.concat(chunks), type: req.headers['content-type'] }); res.writeHead(200, { ETag: '"conf"' }); return res.end(); }
    if (req.method === 'DELETE') { objects.delete(id); res.writeHead(204); return res.end(); }
    if (req.method === 'GET') {
      if (!u.searchParams.get('X-Amz-Signature')) { res.writeHead(403); return res.end('<Error><Code>AccessDenied</Code></Error>'); }
      const o = objects.get(id);
      if (!o) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': String(o.type || 'application/octet-stream') }); return res.end(o.body);
    }
    res.writeHead(405); res.end();
  });
});
await new Promise((r) => s3.listen(S3_PORT, '127.0.0.1', r)); servers.push(s3);

// 3. admin + backend
const ts = path.join(F, 'node_modules/ts-node/register');
await new Promise((resolve, reject) => {
  const p = start('node', ['-r', ts, path.join(F, 'scripts/createAdmin.ts')], 'admin', { ADMIN_EMAIL: 'admin@conf.lykia.local', ADMIN_PASSWORD: 'Conf-Admin-Sifre-1', ADMIN_NAME: 'Platform', ADMIN_SURNAME: 'Admin' });
  p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`createAdmin exit ${c}`))));
});
start('node', ['-r', ts, path.join(F, 'index.ts')], 'server');
await waitHttp(`${API}/api/frontend`, 180_000);
log('backend up');

// 4. provisioning (same steps as tests/e2e/flow-media.mjs / flow-core13.mjs)
const call = async (method, p, { token, body, headers = {} } = {}) => {
  const res = await fetch(`${API}/api${p}`, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: token } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (res.status >= 400) throw new Error(`${method} ${p} → ${res.status} ${text.slice(0, 300)}`);
  return json;
};
const setOption = (name, value) => db.collection('options').updateOne({ name }, { $set: { type: 'text', value, createDate: new Date(), modifiedDate: new Date() } }, { upsert: true });
const reg = await call('POST', '/auth/register', { body: { password: 'Gizli-Sifre-123', language: 'en', name: 'Conf', surname: 'Owner', email: 'owner@conf.lykia.local' } });
const user = await db.collection('users').findOne({ email: 'owner@conf.lykia.local' });
const ver = await db.collection('verifications').findOne({ userId: user._id, type: 'email' });
await call('POST', '/auth/verify-email', { token: reg.data.token, body: { code: ver?.code || '' } });
const owner = reg.data.token;
const m = (await call('POST', '/merchant', { token: owner, body: { name: 'Conformance Labs' } })).data;
const merchantId = m._id, project = m.projects[0]._id;
const admin = (await call('POST', '/auth/login-admin', { body: { email: 'admin@conf.lykia.local', password: 'Conf-Admin-Sifre-1' } })).data.token;
await call('PUT', `/admin/merchants/${merchantId}/plan`, { token: admin, body: { plan: 'standard' } });
await call('POST', `/admin/merchants/${merchantId}/credits`, { token: admin, body: { type: 'adjustment', amountMicros: 50_000_000, note: 'conformance', idempotencyKey: 'conf-fund-1' } });
const sync = await call('POST', '/admin/catalog/sync', { token: admin });
log('catalog sync', JSON.stringify(sync.data?.seed?.media || sync.data?.summary?.seed?.media || '').slice(0, 120));
const SECRETS = { recraft: 'recraft-PLATFORM-secret-0001', elevenlabs: 'xi-PLATFORM-secret-000000001', bytedance: BYTEDANCE_KEY, together: 'tgp_v1_confPLATFORMsecret00000000000000000000000000' };
for (const [slug, key] of Object.entries(SECRETS)) await call('PUT', `/admin/gateway/providers/${slug}/key`, { token: admin, body: { key } });
for (const slug of ['recraft', 'elevenlabs', 'bytedance']) await call('PUT', `/admin/gateway/providers/${slug}/sales`, { token: admin, body: { enabled: true, note: 'conformance: test agreement', agreementDate: '2026-11-23' } });
const usd = (pico) => (Number(pico) / 1e12).toFixed(12).replace(/0+$/, '').replace(/\.$/, '') || '0';
const MODELS = [
  { slug: 'conf/chat', name: 'Conf Chat', inputs: ['text'], outputs: ['text'], params: ['tools', 'response_format', 'structured_outputs'], pmid: 'conf-chat', p: [150_000, 600_000] },
  { slug: 'conf/embed', name: 'Conf Embed', inputs: ['text'], outputs: ['embedding'], params: ['dimensions'], pmid: 'conf-embed', p: [20_000, 0] },
];
for (const [i, md] of MODELS.entries()) {
  const admins = Object.fromEntries(['name', 'description', 'contextLength', 'maxCompletionTokens', 'inputModalities', 'outputModalities', 'supportedParameters', 'isFree'].map((f) => [f, 'admin']));
  await db.collection('ai_models').updateOne({ slug: md.slug }, { $set: {
    slug: md.slug, canonicalSlug: md.slug, name: md.name, author: 'conf', description: '', contextLength: 128000, maxCompletionTokens: md.outputs.includes('embedding') ? null : 16384,
    modality: `${md.inputs.join('+')}->${md.outputs.join('+')}`, inputModalities: md.inputs, outputModalities: md.outputs, supportedParameters: md.params, isFree: false, enabled: true,
    status: 'active', fieldSources: admins, origin: 'admin', releasedAt: new Date(1790000000_000 + i * 1000), expirationDate: null, removedAt: null, createDate: new Date(), modifiedDate: new Date() } }, { upsert: true });
  const [prompt, completion] = md.p;
  const eff = { raw: { prompt: usd(prompt), completion: usd(completion) }, promptPico: prompt, completionPico: completion, cacheReadPico: null, cacheWritePico: null, requestPico: null, imagePico: null };
  await db.collection('ai_endpoints').updateOne({ modelSlug: md.slug, provider: 'together' }, { $set: {
    providerModelId: md.pmid, candidates: [md.pmid], enabled: true, pricing: eff, priceSource: 'admin', priceSourceUrl: null, priceVerifiedAt: new Date(), providerStatus: 'verified',
    fieldSources: { providerModelId: 'admin', pricing: 'admin', enabled: 'admin' }, origin: 'admin', note: '', modifiedDate: new Date() }, $setOnInsert: { createDate: new Date() } }, { upsert: true });
  const e = await db.collection('ai_endpoints').findOne({ modelSlug: md.slug, provider: 'together' });
  await call('PATCH', `/admin/catalog/endpoints/${e._id}`, { token: admin, body: { note: 'conf' } });
}
const panel = { token: owner, headers: { 'X-Merchant-ID': merchantId } };
const PRESETS = { text: 'conf/chat', embedding: 'conf/embed', image: 'recraft/recraftv4_1', video: 'bytedance/seedance-1.0-pro', tts: 'elevenlabs/eleven_multilingual_v2', stt: 'elevenlabs/scribe_v2' };
for (const [name, model] of Object.entries(PRESETS)) await call('PUT', `/merchant/presets/${name}`, { ...panel, body: { model } });
// A speech preset that carries a default voice (to check the preset-default voice fallback).
await call('PUT', '/merchant/presets/narrator', { ...panel, body: { model: PRESETS.tts, defaults: { voice: 'JBFqnCBsd6RMkjVDRZzb' } } });
const key = (await call('POST', '/merchant/keys', { ...panel, headers: { ...panel.headers, 'X-Project-ID': project }, body: { name: 'conformance' } })).data.key;
await setOption('mediaPollerIntervalMs', '500');
await setOption('mediaExtraHosts.bytedance', 'ark-content.example');

// 5. control server: script the fake chat provider, read state
const ctl = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (req.url === '/script') { gw.script(body.flavor || 'together', body.behaviors || []); res.end('{}'); return; }
    if (req.url === '/requests') { res.end(JSON.stringify(gw.requests?.slice?.(-5) ?? [])); return; }
    if (req.url === '/stop') { res.end('{}'); void stopAll(0); return; }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => ctl.listen(CTL_PORT, '127.0.0.1', r)); servers.push(ctl);

const info = { v1: `${API}/v1`, mcp: `${API}/mcp`, key, control: `http://127.0.0.1:${CTL_PORT}`, cdnHost: '127.0.0.1', merchantId, project };
fs.writeFileSync(path.join(HERE, 'env.json'), JSON.stringify(info, null, 2), { mode: 0o600 });
log('READY', JSON.stringify({ ...info, key: '[written to env.json]' }));
await new Promise(() => {});
