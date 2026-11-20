"""Exercise the account cutover using the built images, synthetic legacy data and localhost only.

Usage: python3 test/accounts-container-smoke.py API_IMAGE WEB_IMAGE
"""
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid


def docker(*args, check=True):
    return subprocess.run(['docker', *args], check=check, capture_output=True, text=True, timeout=45)


def run(api_image, web_image):
    name = 'bimage-accounts-smoke-' + uuid.uuid4().hex[:12]
    api, web = name + '-api', name + '-web'
    with tempfile.TemporaryDirectory(prefix=name + '-') as temp:
        data = Path(temp)
        with sqlite3.connect(data / 'studio.sqlite') as db:
            db.executescript("""
                CREATE TABLE keys(id TEXT PRIMARY KEY,hash TEXT UNIQUE,name TEXT,role TEXT,disabled INTEGER DEFAULT 0,expires TEXT);
                CREATE TABLE settings(owner TEXT PRIMARY KEY,json TEXT);
                INSERT INTO keys(id,hash,name,role) VALUES
                    ('previous-admin','never-accepted','Previous admin','admin'),
                    ('previous-member','never-accepted-2','Previous member','user');
                INSERT INTO settings VALUES ('previous-admin','{"migrationFixture":"admin draft"}');
                INSERT INTO settings VALUES ('previous-member','{"migrationFixture":"member draft"}');
            """)
        try:
            # No outbound route or provider configuration for the API in this test.
            docker('network', 'create', '--internal', name)
            docker('run', '-d', '--name', api, '--network', name, '--network-alias', 'api',
                   '--read-only', '--tmpfs', '/tmp:size=16m', '--memory', '512m', '--cap-drop=ALL',
                   '-e', 'COOKIE_SECURE=true', '-e', 'CONCURRENCY=8', '-v', f'{data}:/app/data', api_image)
            for _ in range(50):
                if docker('exec', api, 'node', '-e', "fetch('http://127.0.0.1:6768/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))", check=False).returncode == 0:
                    break
                time.sleep(.2)
            else:
                raise RuntimeError('API container did not reach health')
            docker('run', '-d', '--name', web, '--network', name, '--read-only', '--user', '101:101',
                   '--tmpfs', '/tmp:size=16m,uid=101,gid=101', '--tmpfs', '/var/cache/nginx:size=16m,uid=101,gid=101',
                   '--tmpfs', '/var/run:size=1m,uid=101,gid=101', '--cap-drop=ALL', web_image)

            def query(method, route, body=None, cookie='', csrf='', origin='https://fixture.example.test', auth=''):
                # Execute the HTTP client on the isolated network: no host port published.
                headers = {'Host': 'fixture.example.test', 'Origin': origin, 'Content-Type': 'application/json'}
                if cookie:
                    headers['Cookie'] = cookie
                if csrf:
                    headers['X-CSRF-Token'] = csrf
                if auth:
                    headers['Authorization'] = auth
                # Input reaches the container via stdin; avoid process arguments for credential fixtures as well.
                client = '''
const http = require('node:http');
const {url, options, body} = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const request = http.request(url, options, response => {
  let content = '';
  response.setEncoding('utf8');
  response.on('data', chunk => content += chunk);
  response.on('end', () => console.log(JSON.stringify({code: response.statusCode, headers: response.headers, content})));
});
request.on('error', () => process.exit(1));
request.setTimeout(5000, () => request.destroy());
request.end(body);
'''
                payload = json.dumps(body, separators=(',', ':')) if body is not None else ''
                headers['Content-Length'] = str(len(payload.encode()))
                wire = json.dumps({'url': f'http://{web}:6767{route}', 'options': {'method': method, 'headers': headers}, 'body': payload})
                result = subprocess.run(['docker', 'exec', '-i', api, 'node', '-e', client], input=wire, text=True, capture_output=True, check=True, timeout=8)
                result = json.loads(result.stdout)
                return result['code'], result['headers'], result['content']

            for _ in range(50):
                try:
                    if query('GET', '/health')[0] == 200:
                        break
                except (ValueError, IndexError, subprocess.SubprocessError):
                    pass
                time.sleep(.2)
            else:
                raise RuntimeError('Web container did not reach health')
            assert query('GET', '/')[0] == 200
            assert json.loads(query('GET', '/api/setup')[2]) == {'required': True}
            assert query('GET', '/api/me', auth='Bearer never-accepted')[0] == 401
            assert query('POST', '/api/setup', {'code': 'wrong', 'password': 'synthetic-password-test'})[0] in (400, 401, 403)
            setup_file = data / 'setup-code.txt'
            assert setup_file.stat().st_mode & 0o777 == 0o600
            payload = {'code': setup_file.read_text().strip(), 'password': 'synthetic-password-test'}
            assert query('POST', '/api/setup', payload, origin='https://another.example.test')[0] == 403
            code, headers, result = query('POST', '/api/setup', payload)
            assert code in (200, 201)
            cookie = headers['set-cookie'][0]
            assert 'HttpOnly' in cookie and 'Secure' in cookie and 'SameSite=Strict' in cookie
            cookie = cookie.split(';', 1)[0]
            admin = json.loads(result)
            assert admin['id'] == 'previous-admin' and admin['email'] == 'admin'
            assert json.loads(query('GET', '/api/setup')[2]) == {'required': False}
            assert query('POST', '/api/setup', payload)[0] == 409
            assert json.loads(query('GET', '/api/settings', cookie=cookie)[2])['migrationFixture'] == 'admin draft'
            users = json.loads(query('GET', '/api/admin/users', cookie=cookie)[2]); assert set(users) == {'users'}
            created = {'email': 'test@example.test', 'role': 'user', 'concurrency': 3, 'password': 'synthetic-member-password'}
            assert query('POST', '/api/admin/users', created, cookie=cookie)[0] == 403
            code, _, result = query('POST', '/api/admin/users', created, cookie=cookie, csrf=admin['csrf'])
            account = json.loads(result)
            assert code == 201 and account['id'] != 'previous-member' and account['concurrency'] == 3
            code, headers, _ = query('POST', '/api/login', {'login': created['email'], 'password': created['password']})
            assert code == 200
            cookie = headers['set-cookie'][0].split(';', 1)[0]
            assert json.loads(query('GET', '/api/settings', cookie=cookie)[2]) == {}
            assert query('GET', '/api/admin/users', cookie=cookie)[0] == 403
            print('Isolated images: HTTPS-origin setup/session flags, legacy ownership preserved, expired authorization retired, and account roles/CSRF verified.')
        finally:
            docker('rm', '-f', web, api, check=False)
            docker('network', 'rm', name, check=False)


if __name__ == '__main__':
    raise SystemExit(run(*sys.argv[1:]))
