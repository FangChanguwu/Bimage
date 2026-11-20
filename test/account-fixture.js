import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const fixturePassword = 'local-test-fixture-password';
export function request(base, pathname, { body, method = body === undefined ? 'GET' : 'POST', headers } = {}) {
  return fetch(new URL(pathname, base), {
    method, headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function session(response) {
  assert.equal(response.ok, true, `fixture login failed (${response.status}): ${await response.clone().text()}`);
  const identity = await response.json();
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie && identity.csrf, 'incomplete session');
  return { identity, headers: { cookie, 'x-csrf-token': identity.csrf } };
}
export async function setupAccount(base, dir, password = fixturePassword) {
  const code = readFileSync(join(dir, 'setup-code.txt'), 'utf8').trim();
  return session(await request(base, '/api/setup', { body: { code, password } }));
}
export async function signIn(base, login, password = fixturePassword) {
  return session(await request(base, '/api/login', { body: { login, password } }));
}
export async function createAccount(base, adminHeaders, fields = {}) {
  const payload = { email: 'member@example.test', password: fixturePassword, name: '', role: 'user', concurrency: 1, ...fields };
  const response = await request(base, '/api/admin/users', { headers: adminHeaders, body: payload });
  assert.equal(response.status, 201, `fixture user creation failed (${response.status}): ${await response.clone().text()}`);
  const user = await response.json();
  return { user, ...await signIn(base, payload.email, payload.password) };
}
