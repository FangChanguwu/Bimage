import { tmpdir } from 'node:os';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../backend/dist/app.js';
import {mkdtempSync} from 'node:fs';
import {createServer} from 'node:http';
import path from 'node:path';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=';
test('automatic dimensions omit upstream fields; actual dimensions, persisted timing and tenant-safe ZIP',async()=>{
 const bodies=[];const mock=createServer(async(q,r)=>{let raw='';for await(const c of q)raw+=c;bodies.push(JSON.parse(raw));await new Promise(r=>setTimeout(r,180));r.end(JSON.stringify({data:[{b64_json:png}]}));});await new Promise(r=>mock.listen(0,'127.0.0.1',r));
 const s=await createApp({dir:mkdtempSync(path.join(tmpdir(),'records-')),adminKey:'test'});const server=s.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 const call=async(p,b,key='test')=>fetch(base+'/api'+p,{method:b?'POST':'GET',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:b?JSON.stringify(b):undefined});
 const wait=async id=>{for(let i=0;i<100;i++){const j=await(await call('/jobs/'+id)).json();if(!['queued','running'].includes(j.status))return j;await new Promise(r=>setTimeout(r,40));}throw Error('timeout');};
 try{
 const p=await(await call('/providers',{name:'mock',baseUrl:`http://127.0.0.1:${mock.address().port}`,allowPrivate:true})).json();
 const form={providerId:p.id,model:'mock-image',prompt:'actual bytes, not requested size',count:2,size:'1024x1024',ratio:'1:1',resolution:'1K',autoSize:true,quality:'auto',output_format:'png',references:[]};
 const {size,ratio,resolution,...automatic}=form;const j=await(await call('/jobs',automatic)).json();const done=await wait(j.id);
 assert.equal(done.status,'succeeded');assert.equal(Object.hasOwn(bodies[0],'size'),false);for(const k of ['aspect_ratio','resolution'])assert.equal(Object.hasOwn(bodies[0],k),false);
 assert.deepEqual(done.tasks.map(t=>[t.width,t.height]),[[1,1],[1,1]]);assert.ok(done.startedAt);assert.ok(done.finishedAt);assert.ok(Date.parse(done.finishedAt)>=Date.parse(done.startedAt));
 const frozen=done.finishedAt;await new Promise(r=>setTimeout(r,100));assert.equal((await(await call('/jobs/'+j.id)).json()).finishedAt,frozen);
 const zip=await call('/jobs/'+j.id+'/download');assert.equal(zip.status,200);assert.match(zip.headers.get('content-type'),/application\/zip/);assert.match(zip.headers.get('content-disposition'),/\.zip/);const {unzipSync}=await import('fflate');const entries=unzipSync(new Uint8Array(await zip.arrayBuffer()));assert.equal(Object.keys(entries).length,2);for(const bytes of Object.values(entries))assert.deepEqual(Buffer.from(bytes),Buffer.from(png,'base64'));
 const other=await(await call('/admin/keys',{name:'other'})).json();assert.equal((await call('/jobs/'+j.id+'/download',null,other.key)).status,404);assert.equal((await call('/assets/'+done.tasks[0].asset,null,other.key)).status,404);
 const manual=await(await call('/jobs',{...form,count:1,autoSize:false,output_format:'webp'})).json();const manualDone=await wait(manual.id);assert.equal(manualDone.status,'succeeded');assert.equal(manualDone.tasks[0].mime,'image/png');assert.equal(bodies.at(-1).size,'1024x1024');
 const single=await call('/jobs/'+manual.id+'/download');assert.match(single.headers.get('content-type'),/image\/png/);assert.match(single.headers.get('content-disposition'),/\.png/);assert.deepEqual(Buffer.from(await single.arrayBuffer()),Buffer.from(png,'base64'));
 }finally{await new Promise(r=>server.close(r));s.close();await new Promise(r=>mock.close(r));}
});
