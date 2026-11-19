import { tmpdir } from 'node:os';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../backend/dist/app.js';
import {mkdtempSync} from 'node:fs';
import path from 'node:path';
test('shared providers are usable without exposing management fields; revocation blocks queued work',async()=>{
 const s=await createApp({dir:mkdtempSync(path.join(tmpdir(),'shared-')),adminKey:'admin',worker:false});const server=s.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const call=async(key,p,b,method=b?'POST':'GET')=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api${p}`,{method,headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:b?JSON.stringify(b):undefined});return {status:r.status,data:await r.json()};};
 try{
 const member=(await call('admin','/admin/keys',{name:'member'})).data.key;
 const p=(await call('admin','/providers',{name:'shared',baseUrl:'http://127.0.0.1:9/v1',apiKey:'never-visible-secret',allowPrivate:true,shared:true,models:[{id:'image',types:['image']}]})).data;
 const list=(await call(member,'/providers')).data;assert.equal(list.length,1);assert.equal(list[0].shared,true);for(const key of ['apiKey','owner','allowPrivate','baseUrl'])assert.equal(key in list[0],false,key);assert.equal(list[0].canManage,false);
 assert.equal((await call(member,`/providers/${p.id}`,{name:'attack'},'PATCH')).status,404);
 assert.equal((await call(member,`/providers/${p.id}`,{},'DELETE')).status,404);
 assert.equal((await call(member,`/providers/${p.id}/models`,{baseUrl:'http://127.0.0.1:9'},'POST')).status,404);
 const form={providerId:p.id,model:'image',prompt:'test',count:1,autoSize:true,quality:'auto',output_format:'png',references:[]};
 const job=await call(member,'/jobs',form);assert.equal(job.status,200);
 await call('admin',`/providers/${p.id}`,{shared:false},'PATCH');
 assert.equal((await call(member,'/jobs',form)).status,404);
 const revoked=(await call(member,'/jobs/'+job.data.id)).data;assert.equal(revoked.tasks[0].status,'cancelled');assert.match(revoked.tasks[0].error,/共享/);
 assert.equal((await call('admin','/providers')).data.length,1);
 const own=await call(member,'/providers',{name:'own shared',baseUrl:'https://example.com',shared:true,models:[{id:'own',types:['image']}]});assert.equal(own.status,200);assert.equal(own.data.canManage,true);assert.equal(own.data.shared,true);const ownList=(await call(member,'/providers')).data;assert.equal(ownList.filter(x=>x.id===own.data.id).length,1,'own shared provider must not be duplicated');assert.equal((await call('admin','/providers')).data.length,2);
 assert.equal((await call(member,'/providers/models',{baseUrl:'http://127.0.0.1:9',allowPrivate:true})).status,403);
 const login=await fetch(`http://127.0.0.1:${server.address().port}/api/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:member})});const session=await login.json(),cookie=login.headers.get('set-cookie').split(';')[0];let out=await fetch(`http://127.0.0.1:${server.address().port}/api/logout`,{method:'POST',headers:{cookie,origin:'https://attacker.example','x-csrf-token':session.csrf}});assert.equal(out.status,403);out=await fetch(`http://127.0.0.1:${server.address().port}/api/logout`,{method:'POST',headers:{cookie,'x-csrf-token':'wrong'}});assert.equal(out.status,403);out=await fetch(`http://127.0.0.1:${server.address().port}/api/logout`,{method:'POST',headers:{cookie,'x-csrf-token':session.csrf}});assert.equal(out.status,200);assert.match(out.headers.get('set-cookie'),/Expires=Thu, 01 Jan 1970/);
 }finally{await new Promise(r=>server.close(r));s.close();}
});
