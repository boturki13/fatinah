#!/usr/bin/env node
import crypto from 'node:crypto';
import path from 'node:path';
import { ROOT, writeJsonAtomic } from './lib.mjs';

const upstream='https://raw.githubusercontent.com/amazon-science/mintaka/main/data';
const output=path.join(ROOT,'content','questions','structured-sources','mintaka-ar.json');
const splits=['train','dev','test'];
const records=[];

function scalarAnswer(item){
  const answer=item?.answer;
  if(!answer)return null;
  if(answer.answerType==='entity'){
    if(!Array.isArray(answer.answer)||answer.answer.length!==1)return null;
    return answer.answer[0]?.label?.ar||null;
  }
  if(!['numerical','date','string'].includes(answer.answerType))return null;
  if(['string','number'].includes(typeof answer.answer))return String(answer.answer);
  return null;
}

for(const split of splits){
  const url=`${upstream}/mintaka_${split}.json`;
  const response=await fetch(url);
  if(!response.ok)throw new Error(`تعذر تنزيل Mintaka ${split}: HTTP ${response.status}`);
  const rows=await response.json();
  for(const item of rows){
    const question=String(item?.translations?.ar||'').trim();
    const answer=String(scalarAnswer(item)||'').trim();
    if(!question||!answer)continue;
    const answerEntityId=item.answer.answerType==='entity'&&item.answer.answer.length===1?item.answer.answer[0]?.name:null;
    records.push({id:`mintaka-${item.id}`,split,category:item.category,complexityType:item.complexityType,question,answer,answerType:item.answer.answerType,answerEntityId,sourceRecordId:item.id,sourceUrl:`https://github.com/amazon-science/mintaka/blob/main/data/mintaka_${split}.json`});
  }
}
const sha256=crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex');
writeJsonAtomic(output,{schemaVersion:1,dataset:'Mintaka',license:'CC BY 4.0',publisher:'Amazon Science',retrievedAt:new Date().toISOString(),sha256,recordCount:records.length,records});
console.log(JSON.stringify({output:path.relative(ROOT,output),recordCount:records.length,sha256},null,2));
