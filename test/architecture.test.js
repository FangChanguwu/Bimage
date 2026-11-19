import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {createApp} from '../backend/dist/app.js';
import {mkdtempSync} from 'node:fs';
import path from 'node:path';
test('API does not serve frontend documents',async()=>{const s=await createApp({dir:mkdtempSync(path.join(tmpdir(),'architecture-')),adminKey:'test-only',worker:false});const server=s.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));try{const r=await fetch(`http://127.0.0.1:${server.address().port}/`);assert.equal(r.status,404);}finally{await new Promise(r=>server.close(r));s.close();}});
test('frontend and backend have independent packages and Vue-only frontend',()=>{assert.ok(existsSync('frontend/package.json'));const p=JSON.parse(readFileSync('frontend/package.json'));assert.ok(p.dependencies.vue);assert.ok(p.devDependencies.typescript);assert.ok(!p.dependencies.react);assert.ok(existsSync('backend/package.json'));assert.ok(!existsSync('src/main.jsx'));});
