#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const bankPath=path.join(root,'server-assets/question-images/curated-question-bank.json');
const bank=JSON.parse(await fs.readFile(bankPath,'utf8'));
const assets=Object.values(bank.categories||{}).flatMap(questions=>questions.flatMap(question=>(
  question.image?.assets||[]).map(asset=>({questionId:question.id,...asset}))));
const requestedConcurrency=Number(process.env.FATINAH_IMAGE_VERIFY_CONCURRENCY||8);
if(!Number.isInteger(requestedConcurrency)||requestedConcurrency<1||requestedConcurrency>16){
  throw new Error('FATINAH_IMAGE_VERIFY_CONCURRENCY must be an integer from 1 to 16');
}
const concurrency=requestedConcurrency;

const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const canonicalAssetRecords=assets.map(({questionId,url,mimeType,bytes,sha256})=>(
  {questionId,url,mimeType,bytes,sha256}));
if(bank.releaseReady!==true||bank.questionCount!==300||bank.assetCount!==600
    ||assets.length!==bank.assetCount
    ||digest(JSON.stringify(bank.categories))!==bank.sha256
    ||digest(JSON.stringify(canonicalAssetRecords))!==bank.assetsSha256
    ||new Set(assets.map(asset=>`${asset.questionId}\u0000${asset.url}`)).size!==assets.length){
  throw new Error('curated_image_bank_not_release_ready');
}

const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));

async function download(asset){
  const url=new URL(asset.url);
  if(url.protocol!=='https:'||url.hostname!=='ata20.com'
      ||!url.pathname.startsWith('/assets/question-images/')){
    throw new Error(`${asset.questionId}: untrusted_asset_url`);
  }
  let lastError;
  for(let attempt=1;attempt<=3;attempt++){
    try{
      const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(30_000),
        headers:{'User-Agent':'FatinahReleaseVerifier/1.3 (https://ata20.com)'}});
      if(!response.ok) throw new Error(`http_${response.status}`);
      const contentType=String(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
      if(contentType!==asset.mimeType) throw new Error(`content_type_${contentType||'missing'}`);
      const declaredBytes=Number(response.headers.get('content-length')||0);
      if(declaredBytes&&declaredBytes!==asset.bytes) throw new Error(`declared_size_${declaredBytes}`);
      const bytes=Buffer.from(await response.arrayBuffer());
      if(bytes.length!==asset.bytes) throw new Error(`size_${bytes.length}`);
      if(digest(bytes)!==asset.sha256) throw new Error('sha256_mismatch');
      return;
    }catch(error){
      lastError=error;
      if(attempt<3) await wait(500*attempt);
    }
  }
  throw new Error(`${asset.questionId}: ${lastError?.message||'remote_verification_failed'}`);
}

let cursor=0;
let verified=0;
async function worker(){
  while(cursor<assets.length){
    const asset=assets[cursor++];
    await download(asset);
    verified++;
  }
}

await Promise.all(Array.from({length:concurrency},()=>worker()));
console.log(JSON.stringify({ready:true,bankVersion:bank.bankVersion,questionCount:bank.questionCount,
  assetCount:assets.length,verified},null,2));
