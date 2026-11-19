import { tmpdir } from 'node:os';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {createApp} from '../backend/dist/app.js';
test('unique admin rotation is atomic, preserves owner and revokes old credentials',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'unique-admin-'));const s=await createApp({dir,adminKey:'test-admin',worker:false});const server=s.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}/api`;
 const call=async(p,body,method='POST',headers={authorization:'Bearer test-admin'})=>{const r=await fetch(base+p,{method,headers:{'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 try{
 const original=(await call('/me',undefined,'GET')).data;
 assert.equal((await call('/admin/keys',{name:'second',role:'admin'})).status,400);
 const user=(await call('/admin/keys',{name:'user'})).data;
 assert.equal((await call('/admin/keys/'+user.id,{role:'admin'},'PATCH')).status,400);
 for(const [method,body] of [['PATCH',{role:'user'}],['PATCH',{disabled:true}],['PATCH',{expires:new Date().toISOString()}],['DELETE',undefined]])assert.equal((await call('/admin/keys/'+original.id,body,method)).status,400);
 assert.throws(()=>s.db.prepare("UPDATE keys SET role='admin' WHERE id=?").run(user.id),/UNIQUE/);
 const a=await call('/login',{key:'test-admin'}),b=await call('/login',{key:'test-admin'}),ah={cookie:a.cookie,'x-csrf-token':a.data.csrf};
 assert.equal((await call('/admin/rotate-key',{currentKey:'wrong',confirm:true},'POST',ah)).status,401);
 assert.equal((await call('/admin/rotate-key',{currentKey:'test-admin'},'POST',ah)).status,400);
 assert.equal((await call('/admin/rotate-key',{currentKey:user.key,confirm:true},'POST',{authorization:'Bearer '+user.key})).status,403);
 for(const newKey of ['short',' '.repeat(16),'x'.repeat(257),'a'.repeat(16)+'\n','test-admin',user.key])assert.equal((await call('/admin/rotate-key',{currentKey:'test-admin',newKey,confirmKey:newKey,confirm:true},'POST',ah)).status,400);
 assert.equal((await call('/admin/rotate-key',{currentKey:'test-admin',newKey:'my-custom-admin-secret',confirmKey:'different',confirm:true},'POST',ah)).status,400);
 s.db.prepare('INSERT INTO settings VALUES(?,?)').run(original.id,'{"kept":true}');
 const results=await Promise.all([call('/admin/rotate-key',{currentKey:'test-admin',newKey:'my-custom-admin-secret',confirmKey:'my-custom-admin-secret',confirm:true},'POST',ah),call('/admin/rotate-key',{currentKey:'test-admin',newKey:'my-custom-admin-secret',confirmKey:'my-custom-admin-secret',confirm:true},'POST',ah)]);
 assert.deepEqual(results.map(x=>x.status).sort(),[200,401]);const rotated=results.find(x=>x.status===200);assert.equal(rotated.data.key,undefined);assert.notEqual(rotated.data.csrf,a.data.csrf);
 assert.equal((await call('/me',undefined,'GET')).status,401);assert.equal((await call('/me',undefined,'GET',{cookie:b.cookie})).status,401);assert.equal((await call('/me',undefined,'GET',ah)).status,401);
 assert.equal((await call('/login',{key:'my-custom-admin-secret'})).status,200);
 const fresh={cookie:rotated.cookie,'x-csrf-token':rotated.data.csrf};assert.equal((await call('/me',undefined,'GET',fresh)).data.id,original.id);assert.equal((await call('/settings',undefined,'GET',fresh)).data.kept,true);assert.equal((await call('/me',undefined,'GET',{authorization:'Bearer '+'my-custom-admin-secret'})).data.id,original.id);
 assert.equal(s.db.prepare("SELECT count(*) n FROM keys WHERE role='admin'").get().n,1);assert.notEqual(s.db.prepare('SELECT hash FROM keys WHERE id=?').get(original.id).hash,'my-custom-admin-secret');assert.equal((await call('/login',{key:'test-admin'})).status,401);
 }finally{await new Promise(r=>server.close(r));s.close();rmSync(dir,{recursive:true,force:true});}
});
test('expired logout clears cookie and server session; hostile origin is rejected',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'logout-'));const s=await createApp({dir,adminKey:'admin',worker:false});const server=s.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{const login=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:'{"key":"admin"}'});const cookie=login.headers.get('set-cookie').split(';')[0];const {csrf}=await login.json();assert.equal((await fetch(base+'/api/logout',{method:'POST',headers:{cookie,origin:'https://evil.invalid','x-csrf-token':csrf}})).status,403);s.db.prepare('UPDATE sessions SET expires=0').run();const r=await fetch(base+'/api/logout',{method:'POST',headers:{cookie,'x-csrf-token':csrf}});assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/canvas_session=;/);assert.equal(s.db.prepare('SELECT count(*) n FROM sessions').get().n,0);
 }finally{await new Promise(r=>server.close(r));s.close();rmSync(dir,{recursive:true,force:true});}
});
