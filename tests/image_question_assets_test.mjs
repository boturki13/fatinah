import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import sharp from 'sharp';
import {fileURLToPath} from 'node:url';
import {
  EVERYDAY_NONVIOLENT_CONTEXT,
  FAMILY_SAFETY_BLOCKED_CATALOG_IDS,
  familySafetyDecision,
} from '../scripts/images/family-safety-policy.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const context={window:{},URL,Response,Headers,Blob,crypto:crypto.webcrypto,console};
context.globalThis=context.window;
vm.runInNewContext(fs.readFileSync(path.join(root,'www/image-assets.js'),'utf8'),context);
vm.runInNewContext(fs.readFileSync(path.join(root,'www/image-question-bank.js'),'utf8'),context);
vm.runInNewContext(fs.readFileSync(path.join(root,'www/image-question-bank-commons.js'),'utf8'),context);
const service=context.window.FatinahImageAssets;
const categories=context.window.__IMAGE_QUESTION_BANK_DATA__;
const questions=Object.values(categories).flat();
const provenance=JSON.parse(fs.readFileSync(path.join(root,'server-assets/question-images/v2/provenance.json'),'utf8')).items;
const releaseManifest=JSON.parse(fs.readFileSync(path.join(root,'server-assets/question-images/release-manifest.json'),'utf8'));
const provenanceById=new Map(provenance.map(item=>[item.id,item]));
const providerNames={commons:'Wikimedia Commons',nasa:'NASA Images',met:'The Metropolitan Museum of Art Open Access'};
const familySafetyExcludedIds=[
  'civilization-greece','civilization-benin','objectx-q3400387',
  'treasurex-q131397','treasurex-q151952','treasurex-q152072','treasurex-q179900',
  'treasurex-q205259','treasurex-q211062','treasurex-q214619','treasurex-q235242',
  'treasurex-q408623','treasurex-q412','treasurex-q465762','treasurex-q516435',
  'treasurex-q552113','treasurex-q609292',
  ...FAMILY_SAFETY_BLOCKED_CATALOG_IDS,
];

assert.deepEqual(
  Object.keys(categories).sort(),
  ['أعلام منو؟','تعرف على الصورة','شنو بالفضاء؟','شنو هالحيوان؟','شنو هالشي؟','كنوز الحضارات','منو هاللاعب؟','وين هالمعلم؟'].sort(),
  'بنك الصور الحالي يجب أن يحتوي الفئات المصورة الثمان المعتمدة محلياً.',
);
assert.deepEqual(
  [...context.window.__RELEASED_IMAGE_CATEGORIES__].sort(),
  releaseManifest.categories.toSorted((a,b)=>a.localeCompare(b,'ar')),
  'لا تظهر إلا فئات الصور المنشورة بالكامل في manifest الإنتاج.',
);
assert.equal(releaseManifest.status,'published');
assert.equal(releaseManifest.categoryCount,7);
assert.equal(releaseManifest.questionCount,875);
assert.equal(releaseManifest.assetCount,1750);
assert.deepEqual(releaseManifest.excludedCategories,['منو هاللاعب؟']);
assert.ok(!releaseManifest.categories.includes('منو هاللاعب؟'),'فئة اللاعبين ممنوعة من حزمة الرفع قبل حقوق الشخصية.');
for(const id of familySafetyExcludedIds){
  assert.ok(!questions.some(question=>question.id===`img-v2-${id}`),`${id}: المحتوى غير المناسب ممنوع من بنك اللعبة.`);
  assert.ok(!provenanceById.has(`img-v2-${id}`),`${id}: بيانات مصدر المحتوى غير المناسب لازم تُحذف.`);
  assert.ok(!releaseManifest.items.some(item=>item.questionId===`img-v2-${id}`),`${id}: المحتوى غير المناسب ممنوع من بيان الرفع.`);
  for(const extension of ['avif','webp']){
    assert.equal(fs.existsSync(path.join(root,'server-assets/question-images/v2',`${id}.${extension}`)),false,
      `${id}.${extension}: ملف المحتوى غير المناسب لازم يكون محذوفاً من المشروع.`);
  }
}
for(const id of FAMILY_SAFETY_BLOCKED_CATALOG_IDS){
  assert.equal(familySafetyDecision('شنو هالشي؟',{id}).allowed,false,
    `${id}: سياسة البناء لازم ترفض المعرّف حتى لو عاد إلى الكتالوج مستقبلاً.`);
}
const sourceCatalog=JSON.parse(fs.readFileSync(path.join(root,'content/image-questions/curated-commons.json'),'utf8'));
for(const category of sourceCatalog.categories){
  for(const item of category.items){
    assert.equal(familySafetyDecision(category.name,item).allowed,true,
      `${item.id}: المصدر نفسه لازم يرفض الجثث والأسلحة الصريحة قبل بناء بنك اللعبة.`);
  }
}
const mozambiqueCatalog=sourceCatalog.categories.find(category=>category.name==='أعلام منو؟')
  ?.items.find(item=>item.id==='flag-mozambique');
assert.ok(mozambiqueCatalog,'علم موزمبيق الرسمي لازم يبقى في مصدر الصور.');
assert.equal(familySafetyDecision('أعلام منو؟',mozambiqueCatalog).reason,'official_country_flag',
  'الأعلام الرسمية لا تُحذف بسبب الرموز الموجودة في تصميمها الوطني.');
const mozambiqueQuestion=questions.find(question=>question.id==='img-v2-flag-mozambique');
assert.ok(mozambiqueQuestion,'علم موزمبيق الرسمي لازم يبقى في بنك اللعبة وبيان الرفع.');
assert.ok(releaseManifest.items.some(item=>item.questionId==='img-v2-flag-mozambique'));
const kitchenKnife=questions.find(question=>question.id==='img-v2-objectx-q599312');
assert.ok(kitchenKnife,'سكين المطبخ تبقى فقط كسياق منزلي يومي غير عنيف.');
assert.equal(kitchenKnife.review.familySafetyContext,EVERYDAY_NONVIOLENT_CONTEXT);
assert.match(`${kitchenKnife.answer} ${kitchenKnife.image.rights.sourcePage}`,/سكين مطبخ|Cucina/i);
assert.ok(releaseManifest.items.every(item=>releaseManifest.categories.includes(item.category)
  &&item.url.startsWith('https://ata20.com/assets/question-images/')));
for(const [category,items] of Object.entries(categories)){
  assert.equal(items.length,125,`${category}: يجب توفير 125 سؤال صورة بعد دمج الصور الأصلية والمستضافة.`);
  for(let difficulty=1;difficulty<=6;difficulty++){
    const expected=difficulty===6?20:21;
    assert.equal(items.filter(question=>question.d===difficulty).length,expected,`${category}: توزيع المستوى ${difficulty} غير متوازن.`);
  }
}

for(const question of questions){
  assert.equal(service.validateQuestion(question),true);
  assert.ok(question.image.alt.trim().length>=12,'كل صورة تحتاج وصفاً صوتياً مفيداً.');
  assert.ok(question.image.factSource.url.startsWith('https://'));
  assert.ok(question.image.rights.owner&&question.image.rights.credit&&question.image.rights.provider&&question.image.rights.license);
  assert.ok(question.image.rights.modifications,'كل صورة تحتاج بيان المعالجة التي أُجريت عليها.');
  assert.ok(question.image.rights.sourcePage.startsWith('https://'));
  assert.ok(question.image.rights.licenseUrl.startsWith('https://'));
  const original=provenanceById.get(question.id);
  if(original){
    assert.equal(question.image.rights.owner,original.creator,`${question.id}: يجب حفظ اسم المالك أو المنشئ من المصدر.`);
    assert.equal(question.image.rights.credit,original.credit||original.creator,`${question.id}: يجب حفظ نص الإسناد الأصلي.`);
    assert.equal(question.image.rights.provider,providerNames[original.provider],`${question.id}: اسم مزود الصورة غير صحيح.`);
    assert.equal(question.image.rights.sourcePage,original.pageUrl,`${question.id}: رابط صفحة الصورة الأصلية غير صحيح.`);
    assert.equal(question.image.rights.licenseUrl,original.licenseUrl,`${question.id}: رابط الرخصة غير صحيح.`);
    if(original.provider!=='commons') assert.doesNotMatch(question.image.rights.provider,/Commons/,`${question.id}: ممنوع نسبة NASA أو Met إلى Commons.`);
  }
  for(const asset of question.image.assets){
    const filename=new URL(asset.url).pathname.split('/').pop();
    const version=new URL(asset.url).pathname.split('/').at(-2);
    const local=path.join(root,'server-assets/question-images',version,filename);
    const bytes=fs.readFileSync(local);
    assert.equal(bytes.byteLength,asset.bytes,`${filename}: الحجم المسجّل يجب أن يطابق الملف.`);
    assert.ok(bytes.byteLength<=service.MAX_IMAGE_BYTES,`${filename}: الملف أكبر من الحد.`);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),asset.sha256,`${filename}: البصمة غير مطابقة.`);
    assert.equal(fs.existsSync(path.join(root,'www',filename)),false,'الصور الكبيرة ممنوعة داخل حزمة التطبيق.');
  }
  const webp=question.image.assets.find(asset=>asset.mimeType==='image/webp');
  const webpName=new URL(webp.url).pathname.split('/').pop();
  const webpVersion=new URL(webp.url).pathname.split('/').at(-2);
  const dimensions=await sharp(path.join(root,'server-assets/question-images',webpVersion,webpName)).metadata();
  assert.ok(Math.min(dimensions.width,dimensions.height)>=240&&dimensions.width*dimensions.height>=160_000,
    `${webpName}: دقة الصورة أقل من الحد الآمن للعرض على iPhone.`);
}

const valid=structuredClone(questions[0]);
for(const url of ['http://ata20.com/assets/question-images/v1/x.webp','https://evil.example/x.webp','https://ata20.com.evil.example/assets/question-images/v1/x.webp','https://ata20.com/other/x.webp']){
  const changed=structuredClone(valid); changed.image.assets[0].url=url;
  assert.throws(()=>service.validateQuestion(changed),/untrusted_url/,'يجب رفض الرابط غير الموثوق.');
}
const missing=structuredClone(valid); delete missing.image;
assert.throws(()=>service.validateQuestion(missing),/image_alt_missing/,'يجب رفض الصورة المفقودة.');
for(const field of ['alt','factSource','rights']){
  const changed=structuredClone(valid); delete changed.image[field];
  assert.throws(()=>service.validateQuestion(changed),/(alt|source|rights)_missing/);
}
for(const field of ['owner','credit','provider','license','licenseUrl','sourcePage','modifications']){
  const changed=structuredClone(valid); delete changed.image.rights[field];
  assert.throws(()=>service.validateQuestion(changed),/image_rights_missing/,`يجب رفض حقوق الصورة إذا غاب الحقل ${field}.`);
}
const large=structuredClone(valid); large.image.assets[0].bytes=service.MAX_IMAGE_BYTES+1;
assert.throws(()=>service.validateQuestion(large),/too_large/,'يجب رفض الملف الكبير من المانيفست.');

const noWebpFallback=structuredClone(valid);
noWebpFallback.image.assets=noWebpFallback.image.assets.filter(asset=>asset.mimeType==='image/avif');
assert.throws(()=>service.validateQuestion(noWebpFallback),/fallback_missing/,'كل صورة AVIF تحتاج نسخة WebP بديلة.');

const narwhal=questions.find(question=>question.id==='img-v2-animal-narwhal');
assert.ok(narwhal,'سؤال النروال لازم يكون موجوداً في بنك الصور.');
assert.equal(narwhal.image.rights.sourcePage,'https://commons.wikimedia.org/wiki/File:Monodon_monoceros.jpg');
assert.match(narwhal.image.alt,/أنياب طويلة/,'وصف النروال الصوتي لازم يوضح العلامة المميزة بالصورة.');
for(const asset of narwhal.image.assets){
  const filename=new URL(asset.url).pathname.split('/').pop();
  const metadata=await sharp(path.join(root,'server-assets/question-images/v2',filename)).metadata();
  assert.ok(metadata.width>=1200&&metadata.height>=900,`${filename}: نسخة النروال لازم تبقى واضحة على iPhone عمودياً وأفقياً.`);
}

const playerQuestions=categories['منو هاللاعب؟'];
assert.deepEqual(
  [...playerQuestions].slice(0,12).map(question=>question.answer),
  ['كريستيانو رونالدو','ليونيل ميسي','نيمار','كيليان مبابي','محمد صلاح','إرلينغ هالاند','لوكا مودريتش','روبرت ليفاندوفسكي','سون هيونغ مين','كيفن دي بروين','مارتا','أيتانا بونماتي'],
  'فئة اللاعبين لازم تبدأ بالقائمة التي تمت مراجعة صورها بصرياً.',
);
for(const question of playerQuestions){
  assert.equal(question.image.rights.provider,'Wikimedia Commons');
  assert.match(question.image.rights.license,/^(CC BY(?:-SA)? (?:2\.0|2\.5|3\.0|4\.0)|Public domain|PDM|CC0)/i);
  assert.match(question.image.rights.sourcePage,/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
  assert.equal(question.review.status,'rights_review_required','صور اللاعبين تبقى محجوبة إلى اعتماد حق الاسم والصورة التجارية.');
}
const appSource=fs.readFileSync(path.join(root,'www/app.js'),'utf8');
assert.match(appSource,/"منو هاللاعب\؟":\{icon:"👟",tone:"lime"\}/,'فئة اللاعبين تحتاج أيقونة مستقلة وملونة في شاشة الاختيار.');
assert.match(appSource,/"رياضة":\[[^\]]*"منو هاللاعب\؟"/,'فئة اللاعبين لازم تظهر تحت مجموعة الرياضة بعد نشر أصولها.');

const objectBlobs=new Map();
let objectSequence=0;
context.window.URL={
  createObjectURL(blob){
    const url=`blob:fatinah-test-${++objectSequence}`;
    objectBlobs.set(url,blob);
    return url;
  },
  revokeObjectURL(url){ objectBlobs.delete(url); },
};
context.window.crypto=crypto.webcrypto;
const cachedResponses=new Map();
context.window.caches={
  async open(){
    return {
      async match(url){ return cachedResponses.get(url)?.clone(); },
      async put(url,response){ cachedResponses.set(url,response.clone()); },
      async delete(url){ return cachedResponses.delete(url); },
    };
  },
};
let preflightRejectedTypes=new Set(['image/avif']);
class TestImage {
  src='';
  async decode(){
    const blob=objectBlobs.get(this.src);
    if(!blob||preflightRejectedTypes.has(blob.type)) throw new Error('unsupported_image_type');
  }
  removeAttribute(name){ if(name==='src') this.src=''; }
}
context.window.Image=TestImage;
const fetchedTypes=[];
context.window.fetch=async url=>{
  const asset=valid.image.assets.find(candidate=>candidate.url===url);
  assert.ok(asset,`طلب أصل غير متوقع: ${url}`);
  fetchedTypes.push(asset.mimeType);
  const filename=new URL(url).pathname.split('/').pop();
  const version=new URL(url).pathname.split('/').at(-2);
  const bytes=fs.readFileSync(path.join(root,'server-assets/question-images',version,filename));
  return new Response(bytes,{status:200,headers:{'Content-Type':asset.mimeType,'Content-Length':String(bytes.byteLength)}});
};

const unsupportedAvif=structuredClone(valid);
unsupportedAvif.id+='-unsupported-avif';
assert.equal(await service.prepareQuestion(unsupportedAvif),true,'يجب تجهيز WebP إذا فشل فك AVIF فعلياً.');
const webpObjectUrl=await service.objectUrl(unsupportedAvif);
assert.equal(objectBlobs.get(webpObjectUrl)?.type,'image/webp','يجب اعتماد WebP بعد فشل AVIF.');
assert.deepEqual(fetchedTypes.slice(0,2),['image/avif','image/webp'],'يجب تجربة AVIF أولاً ثم WebP.');
context.window.URL.revokeObjectURL(webpObjectUrl);

preflightRejectedTypes=new Set();
const renderFallback=structuredClone(valid);
renderFallback.id+='-render-fallback';
const renderedTypes=[];
const renderImage={
  src:'',
  async decode(){
    const type=objectBlobs.get(this.src)?.type;
    renderedTypes.push(type);
    if(type==='image/avif') throw new Error('render_decode_failed');
  },
  removeAttribute(name){ if(name==='src') this.src=''; },
};
const renderedUrl=await service.loadInto(renderFallback,renderImage);
assert.equal(objectBlobs.get(renderedUrl)?.type,'image/webp','فشل AVIF داخل عنصر العرض يجب أن يرجع إلى WebP.');
assert.deepEqual(renderedTypes,['image/avif','image/webp']);
context.window.URL.revokeObjectURL(renderedUrl);

preflightRejectedTypes=new Set(['image/avif','image/webp']);
const unavailable=structuredClone(valid);
unavailable.id+='-all-formats-unavailable';
await assert.rejects(service.prepareQuestion(unavailable),/decode_failed/,'لا يجوز اعتبار السؤال جاهزاً إذا فشل AVIF وWebP.');
assert.equal(service.isReady(unavailable),false);

console.log('✓ صور الأسئلة: نطاق موثوق، بصمة وحجم، حقوق، وAVIF يرجع إلى WebP قبل بدء السؤال');
