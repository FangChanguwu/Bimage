import { tmpdir } from 'node:os';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import path from 'node:path';
import {createApp} from '../backend/dist/app.js';
test('quick prompt sends owned references as vision data URIs and rejects foreign, oversized and invalid references before upstream',async()=>{
 let bodies=[];const mock=createServer(async(q,r)=>{let body='';for await(const c of q)body+=c;bodies.push(JSON.parse(body));r.setHeader('content-type','application/json');r.end(JSON.stringify({choices:[{message:{content:'一只猫，柔和的侧光'}}]}));});await new Promise(r=>mock.listen(0,'127.0.0.1',r));
 const s=await createApp({dir:mkdtempSync(path.join(tmpdir(),'quick-')),adminKey:'test-admin',worker:false});const server=s.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const call=async(p,b,key='test-admin')=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api${p}`,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify(b)});return {status:r.status,data:await r.json()};};
 try{const provider=(await call('/providers',{name:'mock',baseUrl:`http://127.0.0.1:${mock.address().port}/v1`,apiKey:'mock',allowPrivate:true,models:[{id:'vision',types:['text']}]})).data;const owner=s.db.prepare("SELECT id FROM keys WHERE role='admin'").get().id;const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');s.db.prepare('INSERT INTO assets(id,owner,mime,bytes) VALUES(?,?,?,?)').run('owned',owner,'image/png',png);s.db.prepare('INSERT INTO assets(id,owner,mime,bytes) VALUES(?,?,?,?)').run('foreign','other','image/png',png);
 const input={providerId:provider.id,model:'vision',prompt:'一只猫',references:['owned']};const result=await call('/rewrite',input);assert.equal(result.status,200);assert.equal(result.data.text,'一只猫，柔和的侧光');assert.deepEqual(bodies[0].messages[1].content,[{type:'text',text:'一只猫'},{type:'image_url',image_url:{url:'data:image/png;base64,'+png.toString('base64')}}]);
 const system=bodies[0].messages[0];
 assert.equal(system.role,'system');
 // Pin the exact user-approved system message, including paragraph breaks and punctuation.
 assert.equal(createHash('sha256').update(system.content).digest('hex'),'9f71250e6a966ec843f0237caa893f63433b447267481bca3c91088b1d361585');
 for(const references of [['foreign'],['missing'],Array(17).fill('owned'),'owned'])assert.ok((await call('/rewrite',{...input,references})).status>=400);assert.equal(bodies.length,1);
 s.db.prepare('INSERT INTO assets(id,owner,mime,bytes) VALUES(?,?,?,?)').run('huge',owner,'image/png',Buffer.concat([png,Buffer.alloc(8*1024*1024)]));assert.equal((await call('/rewrite',{...input,references:['huge']})).status,400);assert.equal(bodies.length,1);
 const user=(await call('/admin/keys',{name:'member'})).data;assert.equal((await call('/rewrite',input,user.key)).status,404);assert.equal(bodies.length,1);
 }finally{await new Promise(r=>server.close(r));s.close();await new Promise(r=>mock.close(r));}
});
