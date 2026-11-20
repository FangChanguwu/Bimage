import { tmpdir } from 'node:os';
import { loopbackProvider } from './loopback-provider.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {request,setupAccount} from './account-fixture.js';
import path from 'node:path';
import {createApp} from '../backend/dist/app.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
test('16 references reach multipart and vision upstream; 17 rejected before enqueue or charge; text byte bounds retained',async(t)=>{
 const received=[];const mock=createServer(async(q,r)=>{const chunks=[];for await(const c of q)chunks.push(c);const body=Buffer.concat(chunks).toString();received.push({url:q.url,type:q.headers['content-type'],body});r.setHeader('content-type','application/json');r.end(JSON.stringify(q.url.endsWith('/chat/completions')?{choices:[{message:{content:'expanded'}}]}:{data:[{b64_json:png.toString('base64')}]}));});await new Promise(r=>mock.listen(0,'127.0.0.1',r));
 const dir=mkdtempSync(path.join(tmpdir(),'refs16-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const s=await createApp({dir,providerNetwork:loopbackProvider(mock)});const server=s.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 let admin;
 const call=async(p,body)=>{const r=await request(base,'/api'+p,{headers:admin.headers,body});return {status:r.status,data:await r.json()};};
 try{
 admin=await setupAccount(base,dir);
 const p=(await call('/providers',{name:'local-only',baseUrl:`http://127.0.0.1:${mock.address().port}/v1`,apiKey:'fake',allowPrivate:true})).data;
 const owner=admin.identity.id;
 const refs=Array.from({length:17},(_,i)=>'ref-'+i);for(const id of refs)s.db.prepare('INSERT INTO assets(id,owner,mime,bytes) VALUES(?,?,?,?)').run(id,owner,'image/png',Buffer.concat([png,Buffer.from(id)]));
 const form={providerId:p.id,model:'mock',prompt:'all references',count:1,autoSize:true,quality:'auto',output_format:'png',references:refs.slice(0,16)};
 const job=await call('/jobs',form);assert.equal(job.status,200,JSON.stringify(job.data));assert.equal(job.data.form.references.length,16);
 for(let i=0;i<100&&!s.db.prepare("SELECT id FROM tasks WHERE status='succeeded'").get();i++)await new Promise(r=>setTimeout(r,25));
 assert.equal(s.db.prepare("SELECT count(*) n FROM tasks WHERE status='succeeded'").get().n,1);
 assert.match(received[0].type,/multipart\/form-data/);assert.equal((received[0].body.match(/name="image\[\]"/g)||[]).length,16);
 const text=await call('/rewrite',form);assert.equal(text.status,200);const images=JSON.parse(received[1].body).messages[1].content.filter(x=>x.type==='image_url');assert.equal(images.length,16);for(let i=0;i<16;i++)assert.equal(images[i].image_url.url,'data:image/png;base64,'+Buffer.concat([png,Buffer.from(refs[i])]).toString('base64'));
 const before=received.length;for(const endpoint of ['/jobs','/rewrite']){const rejected=await call(endpoint,{...form,references:refs});assert.equal(rejected.status,400);assert.match(rejected.data.error,/16/);}
 assert.equal(s.db.prepare('SELECT count(*) n FROM jobs').get().n,1);assert.equal(s.db.prepare('SELECT count(*) n FROM tasks').get().n,1);assert.equal(received.length,before);
 const big=Buffer.concat([png,Buffer.alloc(6*1024*1024)]);s.db.prepare('INSERT INTO assets(id,owner,mime,bytes) VALUES(?,?,?,?)').run('big',owner,'image/png',big);
 assert.equal((await call('/rewrite',{...form,references:['big','big','big']})).status,400);assert.equal(received.length,before);
 s.db.prepare('INSERT INTO assets(id,owner,mime,bytes) VALUES(?,?,?,?)').run('oversized',owner,'image/png',Buffer.concat([png,Buffer.alloc(8*1024*1024)]));assert.equal((await call('/rewrite',{...form,references:['oversized']})).status,400);assert.equal(received.length,before);
 }finally{await new Promise(r=>server.close(r));await s.close();await new Promise(r=>mock.close(r));}
});
