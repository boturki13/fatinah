import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import sharp from 'sharp';
import {fileURLToPath} from 'node:url';

const difficulty=Number(process.argv[2]);
if(!Number.isInteger(difficulty)||difficulty<1||difficulty>6) throw new Error('Use a difficulty from 1 to 6.');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const context={window:{},URL,Response,Headers,Blob,crypto:crypto.webcrypto,console};
context.globalThis=context.window;
for(const file of ['image-assets.js','image-question-bank.js','image-question-bank-commons.js','curated-image-options.js']){
  vm.runInNewContext(fs.readFileSync(path.join(root,'www',file),'utf8'),context);
}
const ids=new Set(Object.entries(context.window.__CURATED_IMAGE_DIFFICULTIES__)
  .filter(([,level])=>level===difficulty).map(([id])=>id));
const questions=Object.values(context.window.__IMAGE_QUESTION_BANK_DATA__).flat().filter(question=>ids.has(question.id));
const columns=6,tileWidth=220,tileHeight=160;
const parts=await Promise.all(questions.map(async(question,index)=>{
  const base=question.id.replace('img-v2-','');
  const image=await sharp(path.join(root,'server-assets/question-images/v2',`${base}.webp`))
    .resize(210,120,{fit:'contain',background:'#111'}).png().toBuffer();
  const label=Buffer.from(`<svg width="210" height="30"><rect width="210" height="30" fill="#fff"/><text x="4" y="19" font-family="Arial" font-size="11">${base.slice(0,29)}</text></svg>`);
  const left=(index%columns)*tileWidth+5,top=Math.floor(index/columns)*tileHeight+5;
  return [{input:image,left,top},{input:label,left,top:top+123}];
}));
const output=path.join('/tmp',`fatinah-curated-300-level-${difficulty}.jpg`);
await sharp({create:{width:columns*tileWidth,height:8*tileHeight,channels:3,background:'#ddd'}})
  .composite(parts.flat()).jpeg({quality:86}).toFile(output);
console.log(output);
