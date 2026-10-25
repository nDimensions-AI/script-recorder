// A live developer qualification fixture. The credential enters through stdin only.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { WebinarStore } from '../electron/webinar/store.ts';
import { EvidenceService } from '../electron/webinar/evidence.ts';
import { GenerationService } from '../electron/webinar/generation.ts';
import { WordExporter } from '../electron/webinar/export.ts';
import { webinarProviderSettings } from '../common/webinar/provider-profile.ts';
import { uid, now, digest } from '../electron/webinar/core.ts';
let key='',store,root;
try {
  for await(const bytes of process.stdin){key+=bytes.toString();if(key.length>1100)throw new Error('Credential input exceeded its size limit.');}
  key=key.trim();root=fs.mkdtempSync(path.join(os.tmpdir(),'webinar-live-evidence-'));
  store=new WebinarStore(root,path.resolve('electron/webinar/migrations'));
  const profile=webinarProviderSettings(),context={title:'Synthetic code correction fixture',narrator:'Test narrator',audience:'Developers',objective:'Explain the initial failure and correction',targetDurationSeconds:1800,language:'en',glossary:[]};
  const projectId=store.create({context,budgetMicrousd:250000}),db=store.db(projectId),recordingId=uid(),spanId=uid(),evidenceId=uid();
  db.run("INSERT INTO recordings VALUES(?,?,'Captured',1,'{}',?,?,?)",recordingId,'Test narrator',now(),now(),10000000);
  for(const name of ['Presenter A','Presenter B','Presenter C'])db.run('INSERT INTO presenters VALUES(?,?,130,1)',uid(),name);
  db.run('INSERT INTO transcript_spans VALUES(?,?,?,?,?,?,?,?)',spanId,recordingId,0,9000000,'The first command failed when answer was 41. I changed answer to 42, ran it again, and it passed.','developer-fixture','a'.repeat(64),'[]');
  const png=await sharp(Buffer.from('<svg width="1000" height="500" xmlns="http://www.w3.org/2000/svg"><rect width="1000" height="500" fill="#18232f"/><g fill="white" font-family="monospace" font-size="34"><text x="32" y="65">SYNTHETIC DEMO: demo.ts</text><text x="32" y="145">Before: const answer = 41;</text><text x="32" y="215">Terminal: FAIL expected 42</text><text x="32" y="315">After: const answer = 42;</text><text x="32" y="390">Terminal: PASS</text></g></svg>')).png().toBuffer();
  const raw=store.asset(projectId,png,'frame','image/png',{width:1000,height:500});
  db.run('INSERT INTO evidence VALUES(?,?,?,?,?,?)',evidenceId,recordingId,raw.id,3000000,'marker','{}');
  const evidence=new EvidenceService(store),derivative=await evidence.derive(projectId,evidenceId,{crop:{x:0,y:0,width:1000,height:500},masks:[],fill:'#000000',transformVersion:'1'});
  const manifest=evidence.approve(projectId,await evidence.prepare(projectId,[derivative.id],digest(profile),[spanId]));
  const diagnostics=[];
  const fetcher=async(url,options)=>{const response=await fetch(url,options);if(!response.ok){fs.writeFileSync('artifacts/provider-rejected-fixture-request.json',String(options?.body??''));const body=await response.clone().json().catch(()=>({}));diagnostics.push({stage:String(url).split('/').pop(),status:response.status,detail:String(body.error?.message??'').replaceAll(key,'[REDACTED]').slice(0,2000),details:JSON.stringify(body.error?.details??[]).replaceAll(key,'[REDACTED]').slice(0,4000)});fs.writeFileSync('artifacts/provider-live-draft-diagnostics.json',JSON.stringify(diagnostics,null,2));}return response;};
  const service=new GenerationService(store,evidence,fetcher),job=store.claim(projectId,store.newJob(projectId,'compose',{manifestId:manifest.id}));
  const heartbeat=setInterval(()=>{try{store.heartbeat(projectId,job);}catch{}},5000);
  let revision;try{revision=await service.generate(projectId,job,manifest.id,profile,key,new AbortController().signal);}finally{clearInterval(heartbeat);}
  const blocks=revision.document.sections.flatMap(section=>section.blocks),text=blocks.map(block=>block.text).join('\n');
  if(!revision.document.sections.length||!text.includes('41')||!text.includes('42')||!blocks.some(block=>block.imageDerivativeIds.length))throw new Error('Draft did not preserve required values and screenshot evidence.');
  const output=await new WordExporter(store).render(projectId,revision.id,'draft'),docx=store.assetBytes(projectId,output.assetId);
  fs.writeFileSync('artifacts/live-provider-draft.docx',docx);
  const result={passed:true,live:true,modelId:profile.modelId,sections:revision.document.sections.length,blocks:blocks.length,requiredValuesPreserved:true,screenshotAttached:true,sourceLinked:blocks.every(block=>block.refs.length>0),wordBytes:docx.length,requests:store.catalog.all('SELECT state,accounting,charged_microusd FROM provider_requests WHERE project_id=?',projectId)};
  fs.writeFileSync('artifacts/provider-live-draft-check.json',JSON.stringify(result,null,2));process.stdout.write(JSON.stringify(result)+'\n');
}catch(error){const failure={passed:false,live:true,code:error?.code??'VALIDATION',message:String(error?.message??'Live fixture failed.').replaceAll(key,'[REDACTED]'),requests:store?.catalog.all('SELECT state,accounting,reserved_microusd,charged_microusd FROM provider_requests')??[]};fs.appendFileSync('artifacts/provider-live-draft-failures.jsonl',JSON.stringify(failure)+'\n');process.stdout.write(JSON.stringify(failure)+'\n');process.exitCode=1;}
finally{key='';store?.close();if(root){const relative=path.relative(os.tmpdir(),root);if(!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(root).startsWith('webinar-live-evidence-'))fs.rmSync(root,{recursive:true,force:true});}}
