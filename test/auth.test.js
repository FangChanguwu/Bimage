import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../backend/dist/app.js';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
test('authentication, tenant isolation and hashed access keys',async()=>{
 const s=await createApp({dir:mkdtempSync(path.join(process.env.TMPDIR||tmpdir(),'canvas-test-')),adminKey:'test-admin',worker:false});
 const server=s.app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r)); const base=`http://127.0.0.1:${server.address().port}`;
 const call=async(p,key,body,method)=>{const r=await fetch(base+p,{method:method||(body?'POST':'GET'),headers:{'content-type':'application/json',...(key?{authorization:`Bearer ${key}`}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()}};
 try{assert.equal((await call('/api/me')).status,401);assert.equal((await call('/api/me','test-admin')).data.role,'admin');
 const a=(await call('/api/admin/keys','test-admin',{name:'A',role:'user'})).data; const b=(await call('/api/admin/keys','test-admin',{name:'B',role:'user'})).data;
 assert.ok(a.key);assert.equal((await call('/api/admin/keys',a.key)).status,403);
 const p=(await call('/api/providers',a.key,{name:'Private',baseUrl:'https://api.openai.com/v1',apiKey:'never-leak',kind:'image'})).data;
 assert.equal((await call('/api/providers',b.key)).data.length,0);
 assert.ok(!JSON.stringify((await call('/api/providers',a.key)).data).includes('never-leak'));
 assert.equal((await call('/api/providers/'+p.id,b.key,{},'DELETE')).status,404);
 assert.ok(!s.db.prepare('select * from keys').all().some(x=>x.hash==='test-admin'));
 }finally{await new Promise(r=>server.close(r));s.close();}
});
