import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {isFamilySafetyBlocked} from './family-safety-policy.mjs';
import {rebalanceImageBankDifficulty} from './image-bank-difficulty.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const catalogPath=path.join(root,'content/image-questions/curated-commons.json');
const outputDir=path.join(root,'server-assets/question-images/v2');
const outputBank=path.join(root,'www/image-question-bank-commons.js');
const onlyArgumentIndex=process.argv.indexOf('--only');
const onlyId=onlyArgumentIndex>=0?String(process.argv[onlyArgumentIndex+1]||'').trim():'';
if(onlyArgumentIndex>=0&&!onlyId) throw new Error('--only يحتاج معرّف الصورة');
const categoryArgumentIndex=process.argv.indexOf('--category');
const onlyCategory=categoryArgumentIndex>=0?String(process.argv[categoryArgumentIndex+1]||'').trim():'';
if(categoryArgumentIndex>=0&&!onlyCategory) throw new Error('--category يحتاج اسم الفئة');
if(onlyId&&onlyCategory) throw new Error('استخدم --only أو --category، مو الاثنين معاً');
const scopedImport=Boolean(onlyId||onlyCategory);
const allowedLicenses=new Set(['cc0','public domain','pdm','cc by 4.0','cc by-sa 4.0','cc by 3.0','cc by-sa 3.0','cc by 2.5','cc by-sa 2.5','cc by 2.0','cc by-sa 2.0']);
const providerNames={
  commons:'Wikimedia Commons',
  nasa:'NASA Images',
  met:'The Metropolitan Museum of Art Open Access',
};
const imageModifications='تم تدوير الصورة تلقائياً عند الحاجة، وتغيير حجمها إلى حد أقصى 1280 بكسل، وتحويلها وضغطها إلى AVIF وWebP بدون قص.';
const maxDownloadBytes=15*1024*1024;
const maxOutputBytes=450*1024;
const excludedQuestionContent=/إسرائيل|اسرائيل|إسرائيلي|اسرائيلي|تل أبيب|تل ابيب/i;
const flagPrompts=['علم أي دولة هذا؟','هالعلم يرجع لأي دولة؟','تقدر تعرف دولة هالعلم؟','شنو الدولة اللي تستخدم هالعلم؟','أي بلد يمثله هالعلم؟','هذي راية أي دولة؟','عرفت علم أي دولة؟','أي دولة شعارها الوطني بهالشكل؟','هالعلم الوطني حق أي بلد؟','قول اسم الدولة صاحبة هالعلم','أي دولة ترفع هالعلم؟','شنو اسم البلد اللي يمثله هالعلم؟'];
const landmarkPrompts=['بأي دولة موجود هالمعلم؟','وين موجود هالمعلم، بأي بلد؟','هالمعلم يتبع أي دولة؟','تقدر تحدد دولة هالمعلم؟','أي بلد تشوف فيه هالمعلم؟','شنو الدولة اللي تحتضن هالمعلم؟','هالمكان الشهير موجود بأي دولة؟','قول اسم الدولة اللي فيها هالمعلم','إلى أي دولة نسافر عشان نشوف هالمعلم؟','أي بلد معروف بهالمعلم؟','هالموقع التاريخي موجود بأي دولة؟','حدد الدولة اللي فيها هالمعلم'];
const animalPrompts=['شنو هالحيوان؟','تقدر تعرف اسم هالحيوان؟','هذي صورة أي حيوان؟','قول اسم الحيوان اللي بالصورة','أي حيوان تشوف جدامك؟','عرفت هالكائن شنو؟','شنو اسم هالحيوان الغريب؟','هالصورة لأي حيوان؟','أي مخلوق ظاهر بالصورة؟','تقدر تحدد نوع هالحيوان؟','شنو اسم هالكائن النادر؟','هالمخلوق العجيب شنو اسمه؟'];
const spacePrompts=['شنو هالجرم الفضائي؟','تقدر تعرف شنو اللي بالصورة؟','هذي صورة شنو بالفضاء؟','شنو اسم هالكوكب أو الجرم؟','أي جرم سماوي تشوف؟','عرفت هالصورة الفضائية؟','شنو ظاهر بهالصورة من الفضاء؟','حدد اسم هالجرم السماوي','هالمشهد الفضائي شنو اسمه؟','أي عالم بعيد ظاهر بالصورة؟','تقدر تسمي هالمنظر الكوني؟','شنو اسم هالتكوين الفضائي؟'];
const objectPrompts=['شنو هالشي؟','تقدر تعرف اسم هالأداة؟','هذي شنو كانت تُستخدم؟','شنو اسم القطعة الظاهرة؟','أي أداة قديمة تشوف بالصورة؟','عرفت هالجهاز شنو؟','شنو اسم هالاختراع؟','هالقطعة التاريخية شنو؟','تقدر تسمي هالآلة؟','شنو الأداة اللي جدامك؟','هالشي القديم شنو اسمه؟','حدد اسم القطعة المعروضة'];
const civilizationPrompts=['هالقطعة من أي حضارة؟','أي حضارة صنعت هالقطعة؟','هالأثر يرجع لأي حضارة؟','تقدر تحدد حضارة هالقطعة؟','هالعمل التاريخي من أي ثقافة؟','شنو الحضارة المرتبطة بهالأثر؟','هالقطعة تمثل أي حضارة؟','أي شعب تاريخي صنع هالأثر؟','من أي حضارة جاية هالقطعة؟','حدد الحضارة صاحبة هالعمل','هالأثر ينتمي لأي ثقافة تاريخية؟','أي حضارة تركت لنا هالقطعة؟'];
const playerPrompts=['منو هاللاعب؟','عرفت اسم هاللاعب؟','من اللاعب الظاهر بالصورة؟','هذي صورة أي نجم كروي؟','تقدر تسمي هاللاعب؟','أي لاعب تشوف بالصورة؟','من صاحب هالصورة؟','عرفت نجم الملاعب هذا؟','شنو اسم هاللاعب؟','حدد اللاعب الظاهر بالصورة','منو هالنجمة الكروية؟','عرفت اسم هاللاعبة؟'];
const promptSets={'أعلام منو؟':flagPrompts,'وين هالمعلم؟':landmarkPrompts,'شنو هالحيوان؟':animalPrompts,'شنو بالفضاء؟':spacePrompts,'شنو هالشي؟':objectPrompts,'كنوز الحضارات':civilizationPrompts,'منو هاللاعب؟':playerPrompts};
const clean=value=>String(value||'').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
function imageRights(info,provider,verifiedAt=new Date().toISOString().slice(0,10)){
  const sourceProvider=providerNames[provider];
  if(!sourceProvider) throw new Error(`unsupported_provider_${provider}`);
  return {
    owner:info.creator,
    credit:info.credit||info.creator,
    provider:sourceProvider,
    license:info.license,
    licenseUrl:info.licenseUrl,
    sourcePage:info.pageUrl,
    modifications:imageModifications,
    verifiedAt,
  };
}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fetchWithRetry(url,options={}){
  let lastError;
  for(let attempt=0;attempt<4;attempt++){
    try{
      const response=await fetch(url,{...options,signal:AbortSignal.timeout(30000)});
      if(response.status===429||response.status>=500) throw new Error(`retryable_${response.status}`);
      return response;
    }catch(error){ lastError=error; if(attempt<3) await wait(750*(attempt+1)); }
  }
  throw lastError;
}

async function json(url){
  const response=await fetchWithRetry(url,{headers:{'User-Agent':'FatinahImageImporter/1.3 (https://ata20.com)'}});
  if(!response.ok) throw new Error(`request_failed_${response.status}`);
  return response.json();
}
async function commonsFilenameFromWikidata(id){
  const entity=await json(`https://www.wikidata.org/wiki/Special:EntityData/${id}.json`);
  const filename=entity.entities?.[id]?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
  if(!filename) throw new Error(`${id}: missing P18 image`);
  return filename;
}
async function commonsInfo(filename){
  const params=new URLSearchParams({action:'query',format:'json',origin:'*',prop:'imageinfo',iiprop:'url|extmetadata',iiurlwidth:'1600',titles:`File:${filename}`});
  const data=await json(`https://commons.wikimedia.org/w/api.php?${params}`);
  const page=Object.values(data.query?.pages||{})[0];
  const info=page?.imageinfo?.[0];
  if(!info) throw new Error(`${filename}: Commons file not found`);
  const meta=info.extmetadata||{};
  const license=clean(meta.LicenseShortName?.value).toLowerCase();
  if(![...allowedLicenses].some(item=>license===item||license.startsWith(item+' '))){
    throw new Error(`${filename}: license not allowed (${license||'missing'})`);
  }
  const licenseName=clean(meta.LicenseShortName?.value);
  const rawLicenseUrl=clean(meta.LicenseUrl?.value)||(licenseName.toLowerCase().includes('public domain')?'https://creativecommons.org/publicdomain/mark/1.0/':'');
  const licenseUrl=rawLicenseUrl.replace(/^http:\/\//,'https://');
  return {url:info.thumburl||info.url,pageUrl:info.descriptionurl,license:licenseName,licenseUrl,creator:clean(meta.Artist?.value)||'مساهم في Wikimedia Commons',credit:clean(meta.Credit?.value)};
}
async function nasaInfo(nasaId){
  const params=new URLSearchParams({media_type:'image',nasa_id:nasaId});
  const data=await json(`https://images-api.nasa.gov/search?${params}`);
  const item=data.collection?.items?.[0];
  const metadata=item?.data?.[0];
  const image=item?.links?.find(link=>link.render==='image'&&link.width>=1200)
    ||item?.links?.find(link=>link.render==='image');
  if(!metadata||metadata.nasa_id!==nasaId||!image?.href?.startsWith('https://images-assets.nasa.gov/')){
    throw new Error(`${nasaId}: NASA asset missing or untrusted`);
  }
  return {
    url:image.href,
    pageUrl:`https://images.nasa.gov/details/${encodeURIComponent(nasaId)}`,
    license:'NASA Media Usage Guidelines',
    licenseUrl:'https://www.nasa.gov/nasa-brand-center/images-and-media/',
    creator:clean(metadata.secondary_creator)||`NASA ${clean(metadata.center)}`,
    credit:clean(metadata.title),
  };
}
async function metInfo(objectId){
  const object=await json(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${objectId}`);
  if(object.objectID!==objectId||object.isPublicDomain!==true
      ||!object.primaryImageSmall?.startsWith('https://images.metmuseum.org/')){
    throw new Error(`${objectId}: Met object is not public domain or has no trusted image`);
  }
  return {
    url:object.primaryImageSmall,
    pageUrl:object.objectURL||`https://www.metmuseum.org/art/collection/search/${objectId}`,
    license:'Public Domain — Met Open Access',
    licenseUrl:'https://www.metmuseum.org/policies/terms-and-conditions#open-access',
    creator:'The Metropolitan Museum of Art',
    credit:clean(object.creditLine)||clean(object.title),
  };
}
async function download(url){
  const response=await fetchWithRetry(url,{redirect:'follow',headers:{'User-Agent':'FatinahImageImporter/1.3 (https://ata20.com)'}});
  if(!response.ok) throw new Error(`download_failed_${response.status}`);
  const declared=Number(response.headers.get('content-length')||0);
  if(declared>maxDownloadBytes) throw new Error('download_too_large');
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length>maxDownloadBytes) throw new Error('download_too_large');
  return bytes;
}
async function encode(input,format){
  const qualities=format==='avif'?[58,50,42]:[78,70,62,54];
  for(const quality of qualities){
    const pipeline=sharp(input,{limitInputPixels:40_000_000}).rotate()
      .resize({width:1280,height:1280,fit:'inside',withoutEnlargement:true});
    const output=format==='avif'
      ?await pipeline.avif({quality,effort:6}).toBuffer()
      :await pipeline.webp({quality,effort:6}).toBuffer();
    if(output.length<=maxOutputBytes) return output;
  }
  throw new Error(`encoded_${format}_too_large`);
}
const sha256=async bytes=>{ const {createHash}=await import('node:crypto'); return createHash('sha256').update(bytes).digest('hex'); };

async function readExistingBank(){
  const source=await fs.readFile(outputBank,'utf8');
  const context={window:{}};
  const {runInNewContext}=await import('node:vm');
  runInNewContext(source,context,{timeout:1_000});
  const existing=context.window.__IMAGE_QUESTION_COMMONS_DATA__;
  if(!existing||typeof existing!=='object') throw new Error('existing_image_bank_invalid');
  return JSON.parse(JSON.stringify(existing));
}

await fs.mkdir(outputDir,{recursive:true});
const catalog=JSON.parse(await fs.readFile(catalogPath,'utf8'));
const existingProvenance=scopedImport
  ?JSON.parse(await fs.readFile(path.join(outputDir,'provenance.json'),'utf8')).items
  :[];
const reusableProvenanceById=new Map(existingProvenance.map(item=>[item.id,item]));
const bank=scopedImport?await readExistingBank():{};
let provenance=scopedImport?[...existingProvenance]:[];
if(onlyCategory&&Array.isArray(bank[onlyCategory])){
  const replacedIds=new Set(bank[onlyCategory].map(question=>question.id));
  bank[onlyCategory]=[];
  provenance=provenance.filter(item=>!replacedIds.has(item.id));
}
let matchedScopedItem=false;
for(const category of catalog.categories){
  const categoryMatches=!scopedImport
    ||(onlyCategory?category.name===onlyCategory:category.items.some(item=>item.id===onlyId));
  if(!categoryMatches) continue;
  if(!scopedImport||!Array.isArray(bank[category.name])) bank[category.name]=[];
  const target=Number(category.target||category.items.length);
  for(const [itemIndex,item] of category.items.entries()){
    if((!scopedImport||onlyCategory)&&bank[category.name].length>=target) break;
    if(onlyId&&item.id!==onlyId) continue;
    if(isFamilySafetyBlocked(category.name,item)) continue;
    if(excludedQuestionContent.test(`${item.answer||''} ${item.factUrl||''}`)) continue;
    matchedScopedItem=true;
    try {
    const provider=item.provider||'commons';
    const filename=provider==='commons'?(item.file||await commonsFilenameFromWikidata(item.wikidata)):null;
    const existingSource=reusableProvenanceById.get(`img-v2-${item.id}`);
    const info=existingSource?{
      url:existingSource.url,pageUrl:existingSource.pageUrl,license:existingSource.license,
      licenseUrl:existingSource.licenseUrl,creator:existingSource.creator,credit:existingSource.credit,
    }:provider==='nasa'?await nasaInfo(item.nasaId)
      :provider==='met'?await metInfo(item.objectId)
      :await commonsInfo(filename);
    const assets=[];
    let input=null;
    for(const format of ['avif','webp']){
      const basename=`${item.id}.${format}`;
      const assetPath=path.join(outputDir,basename);
      let bytes=await fs.readFile(assetPath).catch(()=>null);
      if(!bytes||bytes.length>maxOutputBytes){
        input=input||await download(info.url);
        bytes=await encode(input,format);
        await fs.writeFile(assetPath,bytes);
      }
      assets.push({url:`https://ata20.com/assets/question-images/v2/${basename}`,mimeType:`image/${format}`,sha256:await sha256(bytes),bytes:bytes.length});
    }
    const webpBytes=await fs.readFile(path.join(outputDir,`${item.id}.webp`));
    const dimensions=await sharp(webpBytes).metadata();
    const width=Number(dimensions.width||0),height=Number(dimensions.height||0);
    if(Math.min(width,height)<240||width*height<160_000) throw new Error(`encoded_image_resolution_too_low_${width}x${height}`);
    const prompts=promptSets[category.name]||objectPrompts;
    const prompt=item.prompt||prompts[itemIndex%prompts.length];
    if(!prompt) throw new Error(`${category.name}: missing prompt ${itemIndex+1}`);
    const playerRightsReviewRequired=category.name==='منو هاللاعب؟';
    const question={id:`img-v2-${item.id}`,d:item.difficulty,q:prompt,answer:item.answer,source:{title:'بيانات العنصر ومصدر الصورة',url:item.factUrl},image:{alt:item.alt,version:String(catalog.version),factSource:{title:'بيانات العنصر',url:item.factUrl},rights:imageRights(info,provider),assets},review:{status:playerRightsReviewRequired?'rights_review_required':'approved',bankVersion:4,reviewer:playerRightsReviewRequired?'Codex — رخصة المصور موثقة؛ حق الاسم والصورة التجارية يحتاج اعتماداً':'Codex — تحقق آلي للمصدر والرخصة؛ مراجعة بصرية قبل النشر',reviewedAt:new Date().toISOString().slice(0,10),religiousSourceAndIsnadConfirmed:false,...(item.familySafety?.context?{familySafetyContext:item.familySafety.context}:{})}};
    const provenanceItem={id:question.id,provider,commonsFile:filename,nasaId:item.nasaId||null,objectId:item.objectId||null,...info};
    if(scopedImport){
      const questionIndex=bank[category.name]?.findIndex(existing=>existing.id===question.id)??-1;
      const provenanceIndex=provenance.findIndex(existing=>existing.id===question.id);
      if(questionIndex>=0) bank[category.name][questionIndex]=question;
      else bank[category.name].push(question);
      if(provenanceIndex>=0) provenance[provenanceIndex]=provenanceItem;
      else provenance.push(provenanceItem);
    }else{
      bank[category.name].push(question);
      provenance.push(provenanceItem);
    }
    console.log(`✓ ${category.name}: ${item.answer} (${info.license})`);
    } catch (error) {
      if(onlyId) throw error;
      console.warn(`↷ ${category.name}: ${item.id} — ${error.message}`);
    }
  }
  if((!scopedImport||onlyCategory)&&bank[category.name].length<target){
    throw new Error(`${category.name}: الأصول المقبولة ${bank[category.name].length}/${target}`);
  }
}
if(scopedImport&&!matchedScopedItem) throw new Error(`${onlyId||onlyCategory}: catalog item not found`);

rebalanceImageBankDifficulty(bank);

const js=`window.__IMAGE_QUESTION_COMMONS_DATA__=${JSON.stringify(bank)};\n(()=>{const target=window.__IMAGE_QUESTION_BANK_DATA__||(window.__IMAGE_QUESTION_BANK_DATA__={});for(const [category,questions] of Object.entries(window.__IMAGE_QUESTION_COMMONS_DATA__))target[category]=[...(Array.isArray(target[category])?target[category]:[]),...questions];})();\n`;
await fs.writeFile(outputBank,js);
await fs.writeFile(path.join(outputDir,'provenance.json'),JSON.stringify({generatedAt:new Date().toISOString(),items:provenance},null,2)+'\n');
