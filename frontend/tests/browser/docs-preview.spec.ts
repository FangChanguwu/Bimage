/// <reference types="node" />
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

// Explicit opt-in: documentation images always use synthetic accounts/assets and
// the real UI, never production data or paid generation.
test.skip(process.env.BIMAGE_UPDATE_DOCS !== '1', 'Documentation capture is opt-in');
for (const language of ['en', 'zh-CN']) {
  test(`localized documentation screenshots ${language}`, async ({ page }) => {
    await page.setViewportSize({ width:1920, height:1080 });
    await page.emulateMedia({ reducedMotion:'reduce' });
    await page.addInitScript(lang=>{localStorage.setItem('bimage-language',lang);localStorage.setItem('bimage-theme','light');},language);
    await page.goto('/Bimage.png');
    const png = await page.evaluate(()=>{
      const c=document.createElement('canvas');c.width=1200;c.height=800;const x=c.getContext('2d')!;
      const sky=x.createLinearGradient(0,0,0,800);sky.addColorStop(0,'#303b69');sky.addColorStop(.65,'#dfa9ae');sky.addColorStop(1,'#f8d7af');x.fillStyle=sky;x.fillRect(0,0,1200,800);
      x.fillStyle='#ffe8b5';x.beginPath();x.arc(860,260,65,0,Math.PI*2);x.fill();
      for(const [y,color,peak] of [[630,'#44476b',260],[720,'#303b57',390],[830,'#1e3043',500]] as const){x.fillStyle=color;x.beginPath();x.moveTo(0,y);x.lineTo(310,peak);x.lineTo(610,y-90);x.lineTo(900,peak+50);x.lineTo(1200,y-120);x.lineTo(1200,800);x.lineTo(0,800);x.fill();}
      x.strokeStyle='#f5d3ad';x.lineWidth=7;x.beginPath();x.moveTo(650,800);x.bezierCurveTo(520,720,780,660,590,620);x.stroke();
      return c.toDataURL('image/png').split(',')[1];
    });
    const english=language==='en';
    const original=english?'A quiet mountain lake at sunrise. A small wooden cabin on the shore. Bright lighting.':'日出时安静的山间湖泊，岸边有一间小木屋。光线明亮。';
    const optimized=english?'A quiet mountain lake at sunrise. A small wooden cabin on the shore, with pale mist drifting across still water. Soft golden light grazes the timber.':'日出时安静的山间湖泊，岸边有一间小木屋，淡雾掠过平静水面。柔和的金色晨光落在木墙上。';
    const form={providerId:'demo',model:'gpt-image-1',prompt:original,count:1,autoSize:true,size:'1024x1024',ratio:'1:1',resolution:'1K',quality:'auto',output_format:'png',references:[]};
    let settings={imageProvider:'demo',imageModel:'gpt-image-1',textProvider:'demo',textModel:'gpt-4.1',quickProvider:'demo',quickModel:'gpt-4.1',form};
    const jobs=[{id:'sample-lake',status:'succeeded',created:'2026-01-01T08:00:00Z',startedAt:'2026-01-01T08:00:00Z',finishedAt:'2026-01-01T08:00:12Z',form:{...form,prompt:english?'Illustrative landscape study: layered mountains at dawn, warm sky, winding water.':'示例风景练习：晨曦中的层叠山峦、暖色天空与蜿蜒水流。'},tasks:[{id:'sample',asset:'sample-art',status:'succeeded',width:1200,height:800,mime:'image/png'}]}];
    const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/api/**',async route=>{
      const r=route.request(),p=new URL(r.url()).pathname.slice(4);
      if(p.startsWith('/assets/'))return route.fulfill({contentType:'image/png',body:r.method()==='HEAD'?undefined:Buffer.from(png,'base64')});
      if(p==='/settings'&&r.method()==='PUT')settings=r.postDataJSON();
      const data:Record<string,unknown>={'/site':{title:'Bimage'},'/setup':{required:false},'/me':{id:'demo-user',name:'Demo',role:'admin',csrf:'synthetic-csrf'},'/providers':[{id:'demo',owner:'demo-user',name:'Demo provider',canManage:true,hasKey:true,models:[{id:'gpt-image-1',types:['image']},{id:'gpt-4.1',types:['text']}]}],'/settings':settings,'/jobs':{items:jobs,total:1,nextCursor:null,token:'demo',active:false,unchanged:false},'/rewrite':{text:optimized}};
      return route.fulfill({json:data[p]??{}});
    });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    await expect(page.locator('.history-count')).toHaveText(english ? '1 record' : '1 个记录');
    await expect(page.locator('.composer textarea')).toHaveValue(original);
    await expect.poll(()=>page.locator('.image-open img').first().evaluate(el=>(el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const suffix=english?'en':'zh';
    await page.screenshot({path:resolve(`../docs/preview-${suffix}.png`),animations:'disabled'});
    await page.locator('.prompt-optimize').click();
    await expect(page.locator('.prompt-box')).toHaveClass(/prompt-review/);
    await expect(page.locator('.prompt-highlight')).toContainText(english?'golden':'晨光');
    await expect(page.locator('.prompt-diff-added').first()).toBeAttached();
    await expect(page.locator('.prompt-diff-removed').first()).toBeAttached();
    await page.screenshot({path:resolve(`../docs/prompt-refinement-${suffix}.png`),animations:'disabled'});
    expect(errors).toEqual([]);
  });
}
