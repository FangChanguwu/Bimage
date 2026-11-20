import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../backend/dist/app.js';
import { fixturePassword, request, setupAccount } from './account-fixture.js';

async function start(t, options = {}, returnAdmin = false) {
  const dir = mkdtempSync(join(tmpdir(), 'bimage-proxy-limit-'));
  let service, server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await service?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  service = await createApp({ dir, worker: false, trustedWebProxyIp: '', ...options });
  server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = await setupAccount(base, dir);
  return returnAdmin ? { base, admin } : base;
}

async function check(base, path, options, expected) {
  const response = await request(base, path, options);
  await response.text();
  assert.equal(response.status, expected);
  if (expected === 429) assert.ok(Number(response.headers.get('retry-after')) > 0);
}

function login(base, headers, status, body = { login: '' }) {
  return check(base, '/api/login', { body, headers }, status);
}

function api(base, headers, status) {
  return check(base, '/api/setup', { headers }, status);
}

function forwarded(ip) {
  return { 'x-real-ip': ip };
}

test('trusted web peer gives login clients independent 20-attempt budgets', async t => {
  const base = await start(t, { trustedWebProxyIp: '::ffff:127.0.0.1' });
  const first = forwarded('192.0.2.1');
  for (let i = 0; i < 20; i++) await login(base, first, 401);
  await login(base, forwarded('::ffff:c000:201'), 429);
  await login(base, forwarded('192.0.2.2'), 200, { login: 'admin', password: fixturePassword });
});

test('trusted web peer gives general API clients independent 180-request budgets', async t => {
  const base = await start(t, { trustedWebProxyIp: '127.0.0.1' });
  const first = forwarded('2001:db8:1::1');
  for (let i = 0; i < 180; i++) await api(base, first, 200);
  await api(base, forwarded('2001:db8:1::2'), 429); // Same IPv6 /56.
  await api(base, forwarded('2001:db8:2::1'), 200);
});

test('standalone and untrusted API peers keep a socket-based login budget', async t => {
  for (const options of [{}, { trustedWebProxyIp: '127.0.0.2' }]) {
    const base = await start(t, options);
    for (let i = 1; i <= 20; i++) await login(base, forwarded(`192.0.2.${i}`), 401);
    await login(base, { ...forwarded('192.0.2.21'), 'x-forwarded-for': '198.51.100.9' }, 429);
  }
});

test('missing or invalid trusted-peer identity uses the socket budget', async t => {
  const base = await start(t, { trustedWebProxyIp: '127.0.0.1' });
  for (let i = 0; i < 20; i++) await login(base, {}, 401);
  for (const identity of ['192.0.2.1, 192.0.2.2', '192.0.2.1:8080', 'not-an-ip', 'fe80::1%eth0']) {
    await login(base, forwarded(identity), 429);
  }
  const duplicate = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: [['content-type', 'application/json'], ['x-real-ip', '192.0.2.1'], ['x-real-ip', '192.0.2.2']],
    body: '{}',
  });
  assert.equal(duplicate.status, 429);
  await duplicate.text();
  await login(base, { 'x-forwarded-for': '192.0.2.1' }, 429);
});

test('trusting the client IP does not trust the forwarded scheme for same-origin checks', async t => {
  const base = await start(t, { trustedWebProxyIp: '127.0.0.1' });
  await login(base, {
    ...forwarded('192.0.2.1'),
    'x-forwarded-proto': 'https',
    'origin': base.replace('http:', 'https:'),
  }, 403);
});

test('non-address web trust configuration fails before creating a database', async () => {
  await assert.rejects(createApp({ trustedWebProxyIp: '127.0.0.0/8', worker: false,
    dir: '/dev/null/bimage' }), /TRUSTED_WEB_PROXY_IP must be a single IP address/);
});

for (const [name, path, alternate] of [
  ['provider discovery', '/api/providers/models', '/api/providers/missing/models'],
  ['rewrite', '/api/rewrite'],
]) {
  test(`${name} gives trusted web clients independent 20-request budgets`, async t => {
    const { base, admin } = await start(t, { trustedWebProxyIp: '127.0.0.1' }, true);
    const call = (ip, status, route = path) => check(base, route, {
      headers: { ...admin.headers, ...forwarded(ip) },
      body: {}, // Reaches the limiter and then fails validation without calling an upstream.
    }, status);
    for (let i = 0; i < 20; i++) await call('192.0.2.1', 400);
    await call('192.0.2.1', 429);
    await call('192.0.2.2', 400);
    if (alternate) {
      await call('192.0.2.1', 429, alternate);
      await call('192.0.2.2', 404, alternate);
    }
  });
}

async function reservePort() {
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  return socket;
}

const nginx = process.env.BIMAGE_TEST_NGINX || 'nginx';
const hasNginx = spawnSync(nginx, ['-V'], { encoding: 'utf8' }).stderr?.includes('--with-http_realip_module');
test('nginx separates trusted ingress clients and ignores address headers on direct web requests', {
  skip: process.platform !== 'linux' || !hasNginx ? 'requires Linux and nginx with http_realip_module' : false,
  timeout: 15_000,
}, async t => {
  const backend = await start(t, { trustedWebProxyIp: '127.0.0.1' });
  const dir = mkdtempSync(join(tmpdir(), 'bimage-nginx-limit-'));
  let child, exited;
  t.after(async () => {
    if (child) child.kill();
    await exited;
    rmSync(dir, { recursive: true, force: true });
  });
  const [web, ingressA, ingressB] = await Promise.all([reservePort(), reservePort(), reservePort()]);
  const [webPort, portA, portB] = [web, ingressA, ingressB].map(server => server.address().port);
  const listen = port => `listen 127.0.0.1:${port};`;
  const webConfig = readFileSync(new URL('../frontend/nginx.conf', import.meta.url), 'utf8')
    .replace('listen 6767;', listen(webPort))
    .replaceAll('http://api:6768', backend)
    .replace('/etc/nginx/conf.d/bimage-ingress*.inc', `${dir}/bimage-ingress*.inc`);
  writeFileSync(join(dir, 'bimage-ingress-test.inc'), 'set_real_ip_from 127.0.0.2;\n');
  // These two listeners simulate distinct client IPs asserted by the same
  // ingress. proxy_bind exercises the web proxy's actual TCP trust check.
  const ingress = (port, clientIp) => `server {
    ${listen(port)}
    location / {
      proxy_bind 127.0.0.2;
      proxy_pass http://127.0.0.1:${webPort};
      proxy_set_header Host $http_host;
      proxy_set_header X-Real-IP ${clientIp};
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
  }`;
  writeFileSync(join(dir, 'nginx.conf'), `daemon off;
    master_process off;
    pid ${dir}/nginx.pid;
    error_log stderr warn;
    events {}
    http {
      access_log off;
      client_body_temp_path ${dir}/body;
      proxy_temp_path ${dir}/proxy;
      fastcgi_temp_path ${dir}/fastcgi;
      scgi_temp_path ${dir}/scgi;
      uwsgi_temp_path ${dir}/uwsgi;
      ${webConfig}
      ${ingress(portA, '192.0.2.1')}
      ${ingress(portB, '192.0.2.2')}
    }`);
  await Promise.all([web, ingressA, ingressB].map(server => new Promise(resolve => server.close(resolve))));
  child = spawn(nginx, ['-p', `${dir}/`, '-c', 'nginx.conf'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { log += chunk; });
  exited = new Promise(resolve => child.once('close', resolve));
  const url = port => `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100 && child.exitCode === null; i++) {
    try {
      const health = await request(url(portA), '/health');
      await health.text();
      if (health.ok) { ready = true; break; }
    } catch { /* waiting for the listeners */ }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(ready, log || 'isolated nginx failed to start');

  const direct = url(webPort), first = url(portA), second = url(portB);
  for (let i = 0; i < 20; i++) await login(first, {}, 401);
  await login(first, { ...forwarded('192.0.2.2'), 'x-forwarded-for': '192.0.2.2' }, 429);
  await login(second, { origin: second }, 200, { login: 'admin', password: fixturePassword });
  // A direct request naming the exhausted client still has its own socket budget.
  for (let i = 0; i < 20; i++) await login(direct, forwarded('192.0.2.1'), 401);
  await login(direct, forwarded('192.0.2.2'), 429);
  // All 21 attempts above also counted against the first client's API budget.
  for (let i = 21; i < 180; i++) await api(first, {}, 200);
  await api(first, forwarded('192.0.2.2'), 429);
  await api(second, {}, 200);
  await check(first, '/health', {}, 200);
});
