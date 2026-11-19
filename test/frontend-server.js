import {createServer,request} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
// Test-only static host. Production uses nginx, never the Node REST service.
export async function serveFrontend(apiServer){
 const port=apiServer.address().port,root=path.resolve('frontend/dist');
 const server=createServer(async(q,r)=>{try{
 if(q.url.startsWith('/api')||q.url==='/health'){
  const proxy=request({hostname:'127.0.0.1',port,path:q.url,method:q.method,headers:q.headers},out=>{r.writeHead(out.statusCode,out.headers);out.pipe(r);});
  proxy.on('error',()=>{if(!r.headersSent)r.writeHead(502);r.end('Proxy unavailable');});
  r.on('close',()=>{if(!r.writableFinished)proxy.destroy();});q.pipe(proxy);return;
 }
 const clean=decodeURIComponent(q.url.split('?')[0]);let file=path.resolve(root,'.'+clean);if(!file.startsWith(root+path.sep)&&file!==root){r.writeHead(403);return r.end();}
 try{if(!(await stat(file)).isFile())file=path.join(root,'index.html');}catch{file=path.join(root,'index.html');}
 const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'};r.setHeader('content-type',mime[path.extname(file)]||'application/octet-stream');r.end(await readFile(file));
 }catch{r.writeHead(502);r.end('Proxy unavailable');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const close=apiServer.close.bind(apiServer);apiServer.close=(cb)=>server.close(()=>close(cb));
 return server;
}
