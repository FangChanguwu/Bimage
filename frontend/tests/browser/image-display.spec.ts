import { test, expect } from '@playwright/test';

test('loaded thumbnails keep their source across scroll and original opens without an intersection callback', async ({ page }) => {
  const image = await page.request.get('/Bimage.png').then(r=>r.body());
  const reads: string[] = [];
  await page.route('**/api/**',async route=>{
    const req=route.request(),url=new URL(req.url()),p=url.pathname.slice(4);
    if(p.startsWith('/assets/')) { reads.push(req.method()+url.pathname+url.search); return route.fulfill({contentType:'image/png',body:req.method()==='HEAD'?undefined:image}); }
    const form={providerId:'p',model:'image',prompt:'display fixture',count:1,autoSize:true,size:'1024x1024',ratio:'1:1',quality:'auto',output_format:'png',references:[]};
    const jobs=Array.from({length:12},(_,i)=>({id:'j'+i,status:'succeeded',created:'2026-01-01T00:00:00Z',form,tasks:[{id:'t'+i,asset:'a'+i,status:'succeeded',width:512,height:512,mime:'image/png'}]}));
    const data:Record<string,unknown>={ '/site':{title:'Fixture'},'/setup':{required:false},'/me':{id:'a',role:'admin',name:'A',csrf:'fixture'},'/providers':[{id:'p',name:'P',owner:'a',models:[{id:'image',types:['image']}]}],'/settings':{},'/jobs':{items:jobs,total:12,nextCursor:null,token:'1',active:false,unchanged:false}};
    return route.fulfill({json:data[p]??{}});
  });
  await page.setViewportSize({width:1440,height:800});
  await page.goto('/');
  const first=page.locator('.image-open img').first();
  await expect.poll(()=>first.evaluate(e=>(e as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  const source=await first.getAttribute('src');
  const changes=await first.evaluateHandle(el=>{
    const removed:string[]=[];
    new MutationObserver(()=>{if(!el.getAttribute('src'))removed.push('blank');}).observe(el,{attributes:true,attributeFilter:['src']});
    return removed;
  });
  await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
  await page.waitForTimeout(350);
  expect(await first.getAttribute('src')).toBe(source);
  await page.evaluate(()=>window.scrollTo(0,0));
  await expect(first).toBeInViewport();
  expect(await changes.jsonValue()).toEqual([]);
  expect(reads.filter(r=>/^GET\/api\/assets\/[^?]+$/.test(r))).toHaveLength(0);
  // Native dialog opens after its children mount; original loading must not
  // depend on a measurable intersection of an initially source-less image.
  await page.evaluate(()=>{
    const Observer=window.IntersectionObserver;
    window.IntersectionObserver=class extends Observer {
      constructor(callback:IntersectionObserverCallback,options?:IntersectionObserverInit){super((entries,observer)=>callback(entries.filter(e=>!e.target.closest('.lightbox-stage')),observer),options);}
    };
  });
  await page.getByRole('button',{name:'查看图片',exact:true}).first().click();
  const original=page.getByRole('dialog',{name:'图片预览'}).locator('img');
  await expect.poll(()=>original.evaluate(e=>(e as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  expect(reads.filter(r=>/^GET\/api\/assets\/[^?]+$/.test(r))).toHaveLength(1);
  await page.getByRole('button',{name:'放大',exact:true}).click();
  await expect.poll(()=>original.evaluate(e=>(e as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await page.screenshot({path:test.info().outputPath('original-loaded.png')});
});
