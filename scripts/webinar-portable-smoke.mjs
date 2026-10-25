// The NSIS portable launcher does not preserve Playwright's inspector pipe.
// Connect to its isolated test profile through Chromium's published loopback port.
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {sha256File} from './compliance.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.WEBINAR_PLAYWRIGHT??'playwright');
const [profile,extracted]=process.argv.slice(2);assert(profile&&extracted);
const port=readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split(/\r?\n/)[0];assert(/^\d+$/.test(port));
const browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);
try{
  let page;for(let attempt=0;attempt<300;attempt++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('#webinar'));if(page)break;await new Promise(resolve=>setTimeout(resolve,100));}assert(page);
  await page.waitForSelector('.webinar-app');
  const result=await page.evaluate(async()=>{
    const created=await window.webinar.invoke('project.create',{context:{title:'Portable executable verification',narrator:'CharanTheAiGuy',audience:'Test presenters',objective:'Verify the delivered executable',targetDurationSeconds:1800,language:'en',glossary:[]},budgetMicrousd:0});
    if(!created.ok)throw new Error(created.error);
    const snapshot=await window.webinar.invoke('project.snapshot',{projectId:created.value.projectId});if(!snapshot.ok)throw new Error(snapshot.error);
    return {projectId:snapshot.value.projectId,title:snapshot.value.context.title,userAgent:navigator.userAgent};
  });
  const expected=await sha256File('release/win-unpacked/resources/app.asar'),actual=await sha256File(path.join(extracted,'resources/app.asar'));assert.equal(actual,expected);
  const binary=await sha256File(path.join(extracted,'nDimensions.AI Script Recorder.exe'));assert.equal(binary,await sha256File('release/win-unpacked/nDimensions.AI Script Recorder.exe'));
  await page.screenshot({path:'artifacts/portable-smoke.png',fullPage:true});
  writeFileSync('artifacts/portable-smoke.json',JSON.stringify({passed:true,...result,asarSha256:actual,appBinarySha256:binary},null,2));
  console.log('Delivered portable executable passed launch, SQLite and payload-integrity checks.');
  const session=await browser.newBrowserCDPSession();await Promise.race([session.send('Browser.close').catch(()=>{}),new Promise(resolve=>setTimeout(resolve,1000))]);
}finally{await Promise.race([browser.close(),new Promise(resolve=>setTimeout(resolve,1000))]);}
