import fs from 'node:fs';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import assert from 'node:assert/strict';
const wav=fs.readFileSync('artifacts/asr-reference.wav');let data,rate,channels,bits;
for(let i=12;i+8<=wav.length;){const size=wav.readUInt32LE(i+4),kind=wav.toString('ascii',i,i+4);if(kind==='fmt '){assert.equal(wav.readUInt16LE(i+8),1);channels=wav.readUInt16LE(i+10);rate=wav.readUInt32LE(i+12);bits=wav.readUInt16LE(i+22);}if(kind==='data')data=wav.subarray(i+8,i+8+size);i+=8+size+(size%2);}
assert.equal(rate,16000);assert.equal(channels,1);assert.equal(bits,16);assert(data);
const samples=new Float32Array(data.length/2);for(let i=0;i<samples.length;i++)samples[i]=data.readInt16LE(i*2)/32768;
const worker=new Worker(path.resolve('dist-electron/webinar-compute.js'));
try{
  const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('ASR qualification timed out')),20*60000);worker.on('error',reject);worker.on('message',m=>{if(m.kind==='progress'){if(m.status==='done')console.log('Model file ready');return;}clearTimeout(timer);m.ok?resolve(m.value):reject(new Error(m.error));});worker.postMessage({id:'qualification',method:'transcribe',samples,cacheDir:path.resolve('artifacts/model-cache'),allowDownload:true});});
  assert.match(result.text.toLowerCase(),/command/);assert(result.chunks?.length);fs.writeFileSync('artifacts/asr-smoke.json',JSON.stringify({passed:true,durationSeconds:samples.length/16000,result},null,2));console.log('Local Whisper ASR passed:',result.text);
}finally{await worker.terminate();}
