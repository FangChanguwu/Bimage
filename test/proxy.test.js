import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import path from 'node:path';
import {createApp} from '../backend/dist/app.js';
import {serveFrontend} from './frontend-server.js';
test('same-origin proxy preserves host for CSRF logout',async()=>{
 const s=await createApp({dir:mkdtempSync(path.join(tmpdir(),'proxy-')),adminKey:'proxy-test',worker:false});
 const server=s.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const front=await serveFrontend(server),base=`http://127.0.0.1:${front.address().port}`;
 try{const login=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:'proxy-test'})});const {csrf}=await login.json();const cookie=login.headers.get('set-cookie').split(';')[0];
 const out=await fetch(base+'/api/logout',{method:'POST',headers:{origin:base,cookie,'x-csrf-token':csrf,'content-type':'application/json'},body:'{}'});assert.equal(out.status,200);assert.equal(s.db.prepare('SELECT count(*) n FROM sessions').get().n,0);
 }finally{await new Promise(r=>server.close(r));s.close();}
});
