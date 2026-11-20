import { tmpdir } from 'node:os';
import { loopbackProvider } from './loopback-provider.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../backend/dist/app.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {createAccount,request,setupAccount} from './account-fixture.js';
import {createServer} from 'node:http';
import path from 'node:path';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=';
test('automatic dimensions omit upstream fields; actual dimensions, persisted timing and tenant-safe ZIP',async(t)=>{
 const bodies=[];const mock=createServer(async(q,r)=>{let raw='';for await(const c of q)raw+=c;bodies.push(JSON.parse(raw));await new Promise(r=>setTimeout(r,180));r.end(JSON.stringify({data:[{b64_json:png}]}));});await new Promise(r=>mock.listen(0,'127.0.0.1',r));
 const dir=mkdtempSync(path.join(tmpdir(),'records-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const s=await createApp({dir,providerNetwork:loopbackProvider(mock)});const server=s.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 let admin;
 const call=(p,body,headers=admin.headers)=>request(base,'/api'+p,{body,headers});
 const wait=async id=>{for(let i=0;i<100;i++){const j=await(await call('/jobs/'+id)).json();if(!['queued','running'].includes(j.status))return j;await new Promise(r=>setTimeout(r,40));}throw Error('timeout');};
 try{
 admin=await setupAccount(base,dir);
 const p=await(await call('/providers',{name:'mock',baseUrl:`http://127.0.0.1:${mock.address().port}`,allowPrivate:true})).json();
 const form={providerId:p.id,model:'mock-image',prompt:'actual bytes, not requested size',count:2,size:'1024x1024',ratio:'1:1',resolution:'1K',autoSize:true,quality:'auto',output_format:'png',references:[]};
 const {size,ratio,resolution,...automatic}=form;const j=await(await call('/jobs',automatic)).json();const done=await wait(j.id);
 assert.equal(done.status,'succeeded');assert.equal(Object.hasOwn(bodies[0],'size'),false);for(const k of ['aspect_ratio','resolution'])assert.equal(Object.hasOwn(bodies[0],k),false);
 assert.deepEqual(done.tasks.map(t=>[t.width,t.height]),[[1,1],[1,1]]);assert.ok(done.startedAt);assert.ok(done.finishedAt);assert.ok(Date.parse(done.finishedAt)>=Date.parse(done.startedAt));
 const frozen=done.finishedAt;await new Promise(r=>setTimeout(r,100));assert.equal((await(await call('/jobs/'+j.id)).json()).finishedAt,frozen);
 const zip=await call('/jobs/'+j.id+'/download');assert.equal(zip.status,200);assert.match(zip.headers.get('content-type'),/application\/zip/);assert.match(zip.headers.get('content-disposition'),/\.zip/);const {unzipSync}=await import('fflate');const entries=unzipSync(new Uint8Array(await zip.arrayBuffer()));assert.equal(Object.keys(entries).length,2);for(const bytes of Object.values(entries))assert.deepEqual(Buffer.from(bytes),Buffer.from(png,'base64'));
 const other=await createAccount(base,admin.headers);assert.equal((await call('/jobs/'+j.id+'/download',undefined,other.headers)).status,404);assert.equal((await call('/assets/'+done.tasks[0].asset,undefined,other.headers)).status,404);
 const manual=await(await call('/jobs',{...form,count:1,autoSize:false,output_format:'webp'})).json();const manualDone=await wait(manual.id);assert.equal(manualDone.status,'succeeded');assert.equal(manualDone.tasks[0].mime,'image/png');assert.equal(bodies.at(-1).size,'1024x1024');
 const single=await call('/jobs/'+manual.id+'/download');assert.match(single.headers.get('content-type'),/image\/png/);assert.match(single.headers.get('content-disposition'),/\.png/);assert.deepEqual(Buffer.from(await single.arrayBuffer()),Buffer.from(png,'base64'));
 }finally{await new Promise(r=>server.close(r));await s.close();await new Promise(r=>mock.close(r));}
});
