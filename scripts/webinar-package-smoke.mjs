import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{_electron:electron}=require(process.env.WEBINAR_PLAYWRIGHT??'playwright');
const root=process.cwd(),packaged=!!process.env.WEBINAR_EXE,env={...process.env,WEBINAR_DATA_DIR:mkdtempSync(path.join(tmpdir(),'webinar-package-'))};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:process.env.WEBINAR_EXE??path.join(root,'node_modules/electron/dist/electron.exe'),args:packaged?[]:[root],env,timeout:60000});
try{
  const page=await app.waitForEvent('window',{predicate:p=>p.url().includes('#webinar'),timeout:30000}).catch(()=>app.windows().find(p=>p.url().includes('#webinar')));
  assert(page);await page.waitForSelector('.webinar-app');
  const created=await page.evaluate(async()=>{const r=await window.webinar.invoke('project.create',{context:{title:'Package qualification',narrator:'CharanTheAiGuy',audience:'Presenters',objective:'Verify local package persistence',targetDurationSeconds:1800,language:'en',glossary:[]},budgetMicrousd:0});if(!r.ok)throw new Error(r.error);return r.value;});
  assert(created.projectId);
  const wav=readFileSync('artifacts/asr-reference.wav');let data;
  for(let i=12;i+8<=wav.length;){const size=wav.readUInt32LE(i+4);if(wav.toString('ascii',i,i+4)==='data')data=wav.subarray(i+8,i+8+size);i+=8+size+(size%2);}
  assert(data);const samples=new Float32Array(data.length/2);for(let i=0;i<samples.length;i++)samples[i]=data.readInt16LE(i*2)/32768;
  const result=await app.evaluate(async({utilityProcess,app},input)=>new Promise((resolve,reject)=>{
    const worker=utilityProcess.fork(app.getAppPath()+'/dist-electron/webinar-compute.js',[],{stdio:'pipe'});
    const timer=setTimeout(()=>{worker.kill();reject(new Error('Packaged ASR timed out'));},180000);
    worker.on('message',m=>{if(m.kind==='progress')return;clearTimeout(timer);worker.kill();m.ok?resolve({packaged:app.isPackaged,version:app.getVersion(),electron:process.versions.electron,result:m.value}):reject(new Error(m.error));});
    worker.once('spawn',()=>worker.postMessage({id:'qualification',method:'transcribe',samples:new Float32Array(input.samples),cacheDir:input.cacheDir,allowDownload:false}));
    worker.once('exit',code=>{if(code){clearTimeout(timer);reject(new Error('ASR worker exited '+code));}});
  }),{samples:Array.from(samples),cacheDir:path.resolve('artifacts/model-cache')});
  assert.match(result.result.text.toLowerCase(),/command/);assert.equal(result.packaged,packaged);
  await page.screenshot({path:'artifacts/package-smoke.png',fullPage:true});
  writeFileSync('artifacts/package-smoke.json',JSON.stringify({passed:true,...result},null,2));console.log('Package smoke passed',result.version,result.electron,result.result.text);
}finally{await app.close();}
