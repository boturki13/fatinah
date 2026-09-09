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

// هذا الاختبار يمر على مئات الملفات؛ تعطيل كاش libvips يمنع تراكم مقابض الملفات على macOS.
sharp.cache(false);
sharp.concurrency(2);

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const appSource=fs.readFileSync(path.join(root,'www/app.js'),'utf8');
const context={window:{},URL,Response,Headers,Blob,crypto:crypto.webcrypto,console};
context.globalThis=context.window;
vm.runInNewContext(fs.readFileSync(path.join(root,'www/image-assets.js'),'utf8'),context);
vm.runInNewContext(fs.readFileSync(path.join(root,'www/image-question-bank.js'),'utf8'),context);
vm.runInNewContext(fs.readFileSync(path.join(root,'www/image-question-bank-commons.js'),'utf8'),context);
vm.runInNewContext(fs.readFileSync(path.join(root,'www/curated-image-options.js'),'utf8'),context);
const service=context.window.FatinahImageAssets;
const categories=context.window.__IMAGE_QUESTION_BANK_DATA__;
const questions=Object.values(categories).flat();
const categoryByQuestionId=new Map(Object.entries(categories)
  .flatMap(([category,items])=>items.map(question=>[question.id,category])));
const provenance=JSON.parse(fs.readFileSync(path.join(root,'server-assets/question-images/v2/provenance.json'),'utf8')).items;
const releaseManifest=JSON.parse(fs.readFileSync(path.join(root,'server-assets/question-images/release-manifest.json'),'utf8'));
const curatedBankDocument=JSON.parse(fs.readFileSync(
  path.join(root,'server-assets/question-images/curated-question-bank.json'),'utf8'));
const provenanceById=new Map(provenance.map(item=>[item.id,item]));
const providerNames={commons:'Wikimedia Commons',nasa:'NASA Images',met:'The Metropolitan Museum of Art Open Access'};
const publishedImageCategories=[
  'تعرف على الصورة','أعلام منو؟','وين هالمعلم؟','شنو هالحيوان؟','شنو بالفضاء؟','شنو هالشي؟','كنوز الحضارات',
];
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
  [...context.window.__RELEASED_IMAGE_CATEGORIES__],
  publishedImageCategories,
  'لا تُعلن إلا فئات الصور القادرة على تكوين جولة كاملة.',
);
assert.match(appSource,/function releasedRuntimeImageCategories\(\)/,
  'واجهة اللعبة يجب أن تدمج فئات الصور المنشورة مع كتالوج الخادم.');
assert.match(appSource,/ALL_CATS=names;/,
  'كتالوج الخادم الموحّد للنص والصور يجب أن يكون مصدر فئات التشغيل.');
const curatedV1Questions=categories['تعرف على الصورة'].filter(question=>question.id.startsWith('img-v1-'));
assert.equal(curatedV1Questions.length,12,'فئة الصور المرئية يجب أن تبقى محصورة في 12 صورة مراجعة.');
for(const question of curatedV1Questions){
  assert.equal(question.o.length,4,`${question.id}: سؤال الصورة يحتاج أربعة خيارات.`);
  assert.equal(new Set(question.o).size,4,`${question.id}: خيارات الصورة يجب ألا تتكرر.`);
  assert.equal(question.o[question.a],question.answer,`${question.id}: مؤشر الإجابة لا يطابق النص الصحيح.`);
}
const curatedV2Ids=[...context.window.__CURATED_IMAGE_OPTION_IDS__];
assert.equal(curatedV2Ids.length,288,'قائمة النشر يجب أن تحتوي 288 صورة v2 ليصبح الإجمالي 300.');
const curatedV2Questions=questions.filter(question=>curatedV2Ids.includes(question.id));
assert.equal(curatedV2Questions.length,288,'كل صور قائمة النشر يجب أن تكون موجودة في البنك.');
const releasedImageIds=new Set([...curatedV1Questions.map(question=>question.id),...curatedV2Ids]);
assert.equal(releasedImageIds.size,300,'الإصدار يجب أن يعرض 300 سؤال صورة بالضبط.');
for(let difficulty=1;difficulty<=6;difficulty++){
  assert.equal(curatedV2Questions.filter(question=>context.window.__CURATED_IMAGE_DIFFICULTIES__[question.id]===difficulty).length,48,
    `قائمة v2 تحتاج 48 سؤالاً في المستوى ${difficulty}.`);
}
for(const question of curatedV2Questions){
  assert.equal(familySafetyDecision(
    categoryByQuestionId.get(question.id),question,
  ).allowed,true,`${question.id}: قائمة الصور الـ300 ممنوع أن تتجاوز سياسة المحتوى.`);
  assert.equal(question.o.length,4,`${question.id}: سؤال الصورة يحتاج أربعة خيارات.`);
  assert.equal(new Set(question.o).size,4,`${question.id}: خيارات الصورة يجب ألا تتكرر.`);
  assert.equal(question.o[question.a],question.answer,`${question.id}: مؤشر الإجابة لا يطابق النص الصحيح.`);
}
assert.equal(curatedBankDocument.schemaVersion,1);
assert.equal(curatedBankDocument.questionSchemaVersion,1);
assert.equal(curatedBankDocument.ready,true);
assert.equal(curatedBankDocument.releaseReady,true);
assert.equal(curatedBankDocument.questionCount,300);
assert.equal(curatedBankDocument.targetBankSize,300);
assert.equal(curatedBankDocument.categoryCount,publishedImageCategories.length);
assert.equal(curatedBankDocument.assetCount,600);
assert.equal(curatedBankDocument.questionsPerLevel,2);
assert.match(curatedBankDocument.bankVersion,/^images-v4-curated-[a-f0-9]{16}$/);
assert.deepEqual(curatedBankDocument.publishedCategories,publishedImageCategories);
assert.equal(
  crypto.createHash('sha256').update(JSON.stringify(curatedBankDocument.categories)).digest('hex'),
  curatedBankDocument.sha256,
  'بصمة بنك الصور المنشور لازم تطابق المحتوى الكامل.',
);
const curatedServerQuestions=Object.values(curatedBankDocument.categories).flat();
assert.equal(curatedServerQuestions.length,300);
assert.ok(!curatedServerQuestions.some(question=>question.id==='img-v2-space-nasa-pia04921'),
  'نسخة صورة أندروميدا المكررة ممنوعة من بنك النشر.');
const publishedWebpHashes=curatedServerQuestions.map(question=>
  question.image.assets.find(asset=>asset.mimeType==='image/webp')?.sha256);
assert.equal(new Set(publishedWebpHashes).size,publishedWebpHashes.length,
  'كل سؤال منشور يحتاج صورة فريدة ببصمة مختلفة.');
for(const question of curatedServerQuestions.filter(question=>question.category==='شنو بالفضاء؟')){
  const genericKinds=['مجرة','سديم','كوكب','نجم','قمر'];
  const genericAnswers=new Set([...genericKinds,'مذنب','قمر طبيعي']);
  const asksForGenericType=genericAnswers.has(question.answer);
  assert.ok(question.o.every(option=>genericAnswers.has(option)===asksForGenericType),
    `${question.id}: خيارات الفضاء يجب أن تكون كلها أسماء محددة أو كلها أنواعاً عامة.`);
  for(const kind of genericKinds){
    assert.equal(question.o.includes(kind)&&question.o.some(option=>option.startsWith(`${kind} `)),false,
      `${question.id}: الخيار العام والاسم المحدد لا يجوز أن يكونا صحيحين للصورة نفسها.`);
  }
}
assert.deepEqual(new Set(curatedServerQuestions.map(question=>question.id)),releasedImageIds,
  'أثر الخادم يجب أن يطابق قائمة الـ300 التي يشغلها التطبيق.');
const curatedServerAssetRecords=curatedServerQuestions.flatMap(question=>question.image.assets.map(asset=>({
  questionId:question.id,url:asset.url,mimeType:asset.mimeType,bytes:asset.bytes,sha256:asset.sha256,
})));
assert.equal(
  crypto.createHash('sha256').update(JSON.stringify(curatedServerAssetRecords)).digest('hex'),
  curatedBankDocument.assetsSha256,
  'بصمة أصول الـAVIF/ـWebP لازم تطابق سجلات بنك الصور.',
);
for(const category of publishedImageCategories){
  const published=curatedBankDocument.categories[category];
  assert.ok(Array.isArray(published)&&published.length>=12,`${category}: الفئة لا تكفي لجولة.`);
  for(let difficulty=1;difficulty<=6;difficulty++){
    const count=published.filter(question=>question.d===difficulty).length;
    assert.ok(count>=2,`${category}: المستوى ${difficulty} يحتاج سؤالين على الأقل.`);
    assert.equal(curatedBankDocument.distribution[category].levels[difficulty],count);
  }
}
assert.deepEqual(
  JSON.parse(JSON.stringify(context.window.__CURATED_IMAGE_BANK_METADATA__)),
  Object.fromEntries(Object.entries(curatedBankDocument).filter(([key])=>key!=='categories')),
  'بيانات التطبيق وأثر الخادم لازم يعلنان نفس الإصدار والبصمات.',
);
assert.ok(context.window.__RELEASED_IMAGE_CATEGORIES__.every(category=>releaseManifest.categories.includes(category)),
  'كل فئة معروضة لازم تكون منشورة في manifest الإنتاج.');
assert.equal(releaseManifest.status,'published');
assert.equal(releaseManifest.scope,'playable_curated_bank_only');
assert.equal(releaseManifest.bankVersion,curatedBankDocument.bankVersion);
assert.equal(releaseManifest.bankSha256,curatedBankDocument.sha256);
assert.equal(releaseManifest.categoryCount,7);
assert.equal(releaseManifest.questionCount,300);
assert.equal(releaseManifest.assetCount,600);
assert.deepEqual(new Set(releaseManifest.items.map(item=>item.questionId)),releasedImageIds,
  'بيان النشر يجب أن يقتصر على أسئلة الصور القابلة للعب فقط.');
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
for(const unsafeRecord of [
  {id:'future-rights-record',image:{rights:{owner:'Israel Museum'}}},
  {id:'future-file-record',file:'Example from Israel.jpg'},
  {id:'future-underscored-file',file:'Flag_of_Israel.svg'},
  {id:'future-arabic-record',answer:'معلم إسرائيلي'},
]){
  assert.equal(familySafetyDecision('كنوز الحضارات',unsafeRecord).allowed,false,
    'السياسة لازم تفحص جميع حقول السجل وبيانات الحقوق، مو العنوان فقط.');
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
  const category=categoryByQuestionId.get(question.id);
  assert.equal(familySafetyDecision(category,question).allowed,true,
    `${question.id}: بنك الصور يحتوي سجلاً مرفوضاً.`);
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
  if(releasedImageIds.has(question.id)){
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
}

const valid=structuredClone(questions[0]);
const canonicalAssetUrl=valid.image.assets[0].url;
context.window.location={protocol:'http:',hostname:'127.0.0.1',origin:'http://127.0.0.1:58743'};
assert.equal(
  service.requestUrlForAsset(valid.image.assets[0]),
  `http://127.0.0.1:58743${new URL(canonicalAssetUrl).pathname}`,
  'معاينة loopback يجب أن تحمّل الأصل من نفس المصد لتتجنب CORS مع إبقاء البصمة.',
);
let loopbackRequestUrl='';
const canonicalAsset=valid.image.assets[0];
const canonicalPath=new URL(canonicalAsset.url).pathname;
const canonicalParts=canonicalPath.split('/');
const localAssetBytes=fs.readFileSync(path.join(
  root,'server-assets/question-images',canonicalParts.at(-2),canonicalParts.at(-1),
));
const loopbackVerified=await service.verifiedResponse(canonicalAsset,async requestUrl=>{
  loopbackRequestUrl=requestUrl;
  return new Response(localAssetBytes,{status:200,headers:{
    'Content-Type':canonicalAsset.mimeType,'Content-Length':String(localAssetBytes.byteLength),
  }});
});
assert.equal(loopbackRequestUrl,`http://127.0.0.1:58743${canonicalPath}`);
assert.equal(loopbackVerified.headers.get('X-Fatinah-SHA256'),canonicalAsset.sha256,
  'تغيير مصد طلب loopback لا يلغي فحص SHA-256 الكامل.');
context.window.Capacitor={isNativePlatform:()=>true};
assert.equal(service.requestUrlForAsset(valid.image.assets[0]),canonicalAssetUrl,
  'iOS يجب أن يبقى على HTTPS ata20 ولا يستخدم مسار المعاينة.');
delete context.window.location;
delete context.window.Capacitor;
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
const narwhalPaths=narwhal.image.assets.map(asset=>path.join(
  root,'server-assets/question-images/v2',new URL(asset.url).pathname.split('/').pop()));
if(narwhalPaths.every(assetPath=>fs.existsSync(assetPath))){
  for(const assetPath of narwhalPaths){
    const metadata=await sharp(assetPath).metadata();
    assert.ok(metadata.width>=1200&&metadata.height>=900,
      `${path.basename(assetPath)}: نسخة النروال لازم تبقى واضحة على iPhone عمودياً وأفقياً.`);
  }
}else{
  assert.equal(releaseManifest.items.some(item=>item.questionId===narwhal.id),false,
    'أصل تطويري غائب لا يجوز أن يكون معلناً في manifest الإصدار.');
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
assert.match(appSource,/"منو هاللاعب\؟":\{icon:"👟",tone:"lime"\}/,'فئة اللاعبين تحتاج أيقونة مستقلة وملونة في شاشة الاختيار.');
assert.doesNotMatch(appSource,/NEXT_RELEASE_CATEGORIES=\[[^;]*منو هاللاعب/,
  'صور اللاعبين غير المعتمدة تجارياً يجب ألا تدخل قائمة فئات الإصدار الجديد.');

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
      async delete(url){ return cachedResponses.delete(typeof url==='string'?url:url.url); },
      async keys(){ return [...cachedResponses.keys()]; },
    };
  },
};
let preflightRejectedTypes=new Set(['image/avif']);
let rejectBlobUrls=false;
class TestImage {
  src='';
  async decode(){
    if(rejectBlobUrls&&this.src.startsWith('blob:')) throw new Error('blob_url_decode_disabled');
    if(this.src.startsWith('data:')) return;
    const blob=objectBlobs.get(this.src);
    if(!blob||preflightRejectedTypes.has(blob.type)) throw new Error('unsupported_image_type');
  }
  removeAttribute(name){ if(name==='src') this.src=''; }
}
context.window.Image=TestImage;
const fetchedTypes=[];
context.window.fetch=async url=>{
  const asset=valid.image.assets.find(candidate=>url.endsWith(candidate.mimeType==='image/avif'?'.avif':'.webp'));
  assert.ok(asset,`طلب أصل غير متوقع: ${url}`);
  fetchedTypes.push(asset.mimeType);
  const filename=new URL(asset.url).pathname.split('/').pop();
  const version=new URL(asset.url).pathname.split('/').at(-2);
  const bytes=fs.readFileSync(path.join(root,'server-assets/question-images',version,filename));
  return new Response(bytes,{status:200,headers:{'Content-Type':asset.mimeType,'Content-Length':String(bytes.byteLength)}});
};

function testQuestionVariant(question,suffix){
  const variant=structuredClone(question);
  const match=variant.id.match(/^(img-v[1-9][0-9]{0,2}-)(.+)$/);
  const stem=`${match[2]}-${suffix}`;
  variant.id=`${match[1]}${stem}`;
  variant.image.assets=variant.image.assets.map(asset=>{
    const parsed=new URL(asset.url);
    const extension=parsed.pathname.split('.').pop();
    parsed.pathname=parsed.pathname.replace(/[^/]+\.(?:avif|webp)$/u,`${stem}.${extension}`);
    return {...asset,url:parsed.href};
  });
  return variant;
}

class TestFileReader {
  result=null;
  onload=null;
  onerror=null;
  onabort=null;
  readAsDataURL(blob){
    blob.arrayBuffer().then(buffer=>{
      this.result=`data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
      this.onload?.();
    }).catch(()=>this.onerror?.());
  }
}
context.window.FileReader=TestFileReader;
rejectBlobUrls=true;
preflightRejectedTypes=new Set();
const dataUrlFallbackQuestion=testQuestionVariant(valid,'data-url-fallback');
assert.equal(await service.prepareQuestion(dataUrlFallbackQuestion),true,
  'إذا رفض WebView فك blob: يجب فحص النسخة الموثقة عبر data: قبل رفض الصورة.');
const dataUrlFallbackSource=await service.loadInto(dataUrlFallbackQuestion,new TestImage());
assert.match(dataUrlFallbackSource,/^data:image\/(?:avif|webp);base64,/,
  'مصدر العرض البديل يجب أن يُشتق من Blob الموثق لا من طلب شبكة ثانٍ.');
rejectBlobUrls=false;
delete context.window.FileReader;

let activeDecodes=0;
let maximumConcurrentDecodes=0;
class BoundedDecodeImage {
  src='';
  async decode(){
    activeDecodes+=1;
    maximumConcurrentDecodes=Math.max(maximumConcurrentDecodes,activeDecodes);
    try{
      if(activeDecodes>3) throw new Error('decoder_capacity_exceeded');
      await new Promise(resolve=>setTimeout(resolve,2));
    }finally{ activeDecodes-=1; }
  }
  removeAttribute(name){ if(name==='src') this.src=''; }
}
context.window.Image=BoundedDecodeImage;
const boundedCandidates=[];
for(let difficulty=1;difficulty<=6;difficulty++){
  for(let index=0;index<4;index++){
    const question=testQuestionVariant(valid,`bounded-${difficulty}-${index}`);
    question.d=difficulty;
    boundedCandidates.push(question);
  }
}
const boundedFetchStart=fetchedTypes.length;
const boundedReady=await service.prepareCategory(boundedCandidates,{minimumPerDifficulty:2});
assert.equal(maximumConcurrentDecodes<=3,true,
  'تجهيز الفئة يجب ألا يفتح أكثر من ثلاثة مفككات صور بالتزامن.');
for(let difficulty=1;difficulty<=6;difficulty++){
  assert.equal(boundedReady.get(difficulty)?.size,2,
    `المستوى ${difficulty} يحتاج صورتين جاهزتين فقط للجولة.`);
}
assert.equal(fetchedTypes.length-boundedFetchStart,12,
  'لا يجوز تنزيل بقية صور الفئة بعد تجهيز سؤالين لكل مستوى.');
context.window.Image=TestImage;

const deadlineFetch=context.window.fetch;
const deadlineImage=context.window.Image;
const deadlineAbortController=context.window.AbortController;
const deadlineSetTimeout=context.window.setTimeout;
const deadlineClearTimeout=context.window.clearTimeout;
context.window.AbortController=AbortController;
context.window.setTimeout=setTimeout;
context.window.clearTimeout=clearTimeout;
let deadlineActiveFetches=0;
let deadlineAbortedFetches=0;
context.window.fetch=async(_url,{signal}={})=>new Promise((resolve,reject)=>{
  deadlineActiveFetches+=1;
  signal?.addEventListener('abort',()=>{
    deadlineAbortedFetches+=1;
    deadlineActiveFetches-=1;
    reject(new Error('category_request_aborted'));
  },{once:true});
});
const deadlineCandidates=[];
for(let difficulty=1;difficulty<=6;difficulty++){
  const question=testQuestionVariant(valid,`deadline-${difficulty}`);
  question.d=difficulty;
  deadlineCandidates.push(question);
}
const deadlineStarted=Date.now();
await assert.rejects(service.prepareCategory(deadlineCandidates,{
  minimumPerDifficulty:1,timeoutMs:1000,deadlineAt:Date.now()+25,
}),/category_prepare_timeout/,
'المهلة المطلقة لتجهيز الفئات يجب أن تقطع الطلبات العالقة.');
assert.ok(Date.now()-deadlineStarted<500,'المهلة لا تنتظر مهلة كل ملف على حدة.');
assert.equal(deadlineAbortedFetches,3,'تُلغى فقط الطلبات الثلاثة النشطة عند انتهاء المهلة.');
assert.equal(deadlineActiveFetches,0,'لا تبقى طلبات صور في الخلفية بعد فشل التجهيز.');
for(const question of deadlineCandidates){
  assert.equal(service.isReady(question),false,'السؤال الملغى لا يدخل ذاكرة الصور الجاهزة.');
}

const callerAbort=new AbortController();
context.window.setTimeout(()=>callerAbort.abort(),10);
await assert.rejects(service.prepareCategory(deadlineCandidates,{
  minimumPerDifficulty:1,timeoutMs:1000,signal:callerAbort.signal,
}),/category_prepare_aborted/,
'إلغاء مسار بدء الجولة يجب أن يلغي تجهيز الفئة معه.');
assert.equal(deadlineActiveFetches,0,'إلغاء المستدعي يحرر كل طلبات الفئة.');
context.window.fetch=deadlineFetch;
context.window.Image=deadlineImage;
if(deadlineAbortController===undefined) delete context.window.AbortController;
else context.window.AbortController=deadlineAbortController;
if(deadlineSetTimeout===undefined) delete context.window.setTimeout;
else context.window.setTimeout=deadlineSetTimeout;
if(deadlineClearTimeout===undefined) delete context.window.clearTimeout;
else context.window.clearTimeout=deadlineClearTimeout;

const workingCacheStorage=context.window.caches;
delete context.window.caches;
const cachelessQuestion=testQuestionVariant(valid,'without-cache-storage');
assert.equal(await service.prepareQuestion(cachelessQuestion),true,
  'غياب CacheStorage لا يجوز أن يمنع سؤال الصورة بعد التحقق الكامل من الأصل.');
assert.equal(service.isReady(cachelessQuestion),true,
  'الصورة الموثقة تبقى جاهزة في ذاكرة الجولة عند غياب التخزين الدائم.');

context.window.caches={async open(){ throw new Error('cache_storage_disabled'); }};
preflightRejectedTypes=new Set();
const unavailableCacheQuestion=testQuestionVariant(valid,'unavailable-cache-storage');
assert.equal(await service.prepareQuestion(unavailableCacheQuestion),true,
  'تعطل فتح CacheStorage يجب أن يرجع إلى تنزيل موثق في الذاكرة.');

const verifiedFetch=context.window.fetch;
delete context.window.caches;
context.window.fetch=async url=>{
  const asset=valid.image.assets.find(candidate=>url.endsWith(candidate.mimeType==='image/avif'?'.avif':'.webp'));
  assert.ok(asset,`طلب أصل غير متوقع: ${url}`);
  const filename=new URL(asset.url).pathname.split('/').pop();
  const version=new URL(asset.url).pathname.split('/').at(-2);
  const bytes=Buffer.from(fs.readFileSync(path.join(root,'server-assets/question-images',version,filename)));
  bytes[0]^=0xff;
  return new Response(bytes,{status:200,headers:{'Content-Type':asset.mimeType,'Content-Length':String(bytes.byteLength)}});
};
const tamperedCachelessQuestion=testQuestionVariant(valid,'tampered-without-cache-storage');
await assert.rejects(service.prepareQuestion(tamperedCachelessQuestion),/hash_mismatch/,
  'المسار البديل بلا CacheStorage يجب ألا يتجاوز فحص SHA-256.');
context.window.fetch=verifiedFetch;
context.window.caches=workingCacheStorage;

preflightRejectedTypes=new Set();
const poisonedCacheQuestion=testQuestionVariant(valid,'poisoned-cache-entry');
const poisonedAsset=poisonedCacheQuestion.image.assets.find(asset=>asset.mimeType==='image/avif');
const poisonedCacheKey=service.requestUrlForAsset(poisonedAsset);
cachedResponses.set(poisonedCacheKey,new Response(new Uint8Array([1,2,3]),{status:200,headers:{
  'Content-Type':poisonedAsset.mimeType,'Content-Length':'3','X-Fatinah-SHA256':poisonedAsset.sha256,
}}));
const poisonedFetchStart=fetchedTypes.length;
assert.equal(await service.prepareQuestion(poisonedCacheQuestion),true,
  'ترويسة SHA وحدها لا تكفي؛ نسخة الكاش التالفة يجب حذفها وإعادة تنزيل الأصل.');
assert.equal(fetchedTypes.length-poisonedFetchStart,1,
  'الكاش ذو الجسم غير المطابق يجب أن يسبب تنزيلاً موثقاً جديداً.');
assert.equal((await cachedResponses.get(poisonedCacheKey).clone().blob()).size,poisonedAsset.bytes,
  'بعد اكتشاف تسميم الكاش يجب استبداله بالجسم الصحيح كاملاً.');

const changedManifestQuestion=testQuestionVariant(valid,'changed-manifest-same-id');
assert.equal(await service.prepareQuestion(changedManifestQuestion),true);
assert.equal(service.isReady(changedManifestQuestion),true);
const changedManifestFingerprint=structuredClone(changedManifestQuestion);
for(const asset of changedManifestFingerprint.image.assets) asset.sha256='0'.repeat(64);
assert.equal(service.isReady(changedManifestFingerprint),false,
  'نفس معرف السؤال لا يجوز أن يعيد Blob إذا تغيرت بصمة سجل أصوله.');
await assert.rejects(service.prepareQuestion(changedManifestFingerprint),/hash_mismatch/,
  'تغير بصمة الأصل يجب أن يفرض تنزيله والتحقق منه بدلاً من إعادة ذاكرة قديمة.');
assert.equal(service.isReady(changedManifestFingerprint),false);

const fetchBeforeTimeout=context.window.fetch;
const abortControllerBeforeTimeout=context.window.AbortController;
const setTimeoutBeforeTimeout=context.window.setTimeout;
const clearTimeoutBeforeTimeout=context.window.clearTimeout;
context.window.AbortController=AbortController;
context.window.setTimeout=callback=>{ queueMicrotask(callback); return 1; };
context.window.clearTimeout=()=>{};
context.window.fetch=async(_url,{signal}={})=>new Promise((resolve,reject)=>{
  signal?.addEventListener('abort',()=>reject(new Error('request_aborted')),{once:true});
});
const timedOutQuestion=testQuestionVariant(valid,'download-timeout');
await assert.rejects(service.prepareQuestion(timedOutQuestion),/download_timeout/,
  'طلب أصل لا ينتهي يجب أن يُلغى حتى تقدر الجولة تجربة البديل أو تفشل بوضوح.');
context.window.fetch=fetchBeforeTimeout;
if(abortControllerBeforeTimeout===undefined) delete context.window.AbortController;
else context.window.AbortController=abortControllerBeforeTimeout;
if(setTimeoutBeforeTimeout===undefined) delete context.window.setTimeout;
else context.window.setTimeout=setTimeoutBeforeTimeout;
if(clearTimeoutBeforeTimeout===undefined) delete context.window.clearTimeout;
else context.window.clearTimeout=clearTimeoutBeforeTimeout;

const hangingRenderQuestion=testQuestionVariant(valid,'hanging-render-decode');
preflightRejectedTypes=new Set();
context.window.Image=TestImage;
assert.equal(await service.prepareQuestion(hangingRenderQuestion),true);
const hangingObjectCount=objectBlobs.size;
const hangingImage={
  src:'',
  decode:()=>new Promise(()=>{}),
  removeAttribute(name){ if(name==='src') this.src=''; },
};
context.window.AbortController=AbortController;
context.window.setTimeout=setTimeout;
context.window.clearTimeout=clearTimeout;
const hangingRenderStarted=Date.now();
await assert.rejects(service.loadInto(hangingRenderQuestion,hangingImage,{timeoutMs:25}),/render_timeout/,
  'فك صورة لا ينتهي داخل عنصر العرض يجب أن يتوقف بمهلة محددة.');
assert.ok(Date.now()-hangingRenderStarted<500,'مهلة فك الصورة لا تترك فتح السؤال معلقاً.');
assert.equal(objectBlobs.size,hangingObjectCount,'مهلة فك الصورة يجب أن تحرر رابط Blob المؤقت.');
assert.equal(service.isReady(hangingRenderQuestion),true,
  'تعليق عنصر العرض لا يتلف Blob الموثق ويمكن إعادة المحاولة لاحقاً.');
if(abortControllerBeforeTimeout===undefined) delete context.window.AbortController;
else context.window.AbortController=abortControllerBeforeTimeout;
if(setTimeoutBeforeTimeout===undefined) delete context.window.setTimeout;
else context.window.setTimeout=setTimeoutBeforeTimeout;
if(clearTimeoutBeforeTimeout===undefined) delete context.window.clearTimeout;
else context.window.clearTimeout=clearTimeoutBeforeTimeout;

preflightRejectedTypes=new Set(['image/avif']);
const unsupportedFetchStart=fetchedTypes.length;
const unsupportedAvif=testQuestionVariant(valid,'unsupported-avif');
assert.equal(await service.prepareQuestion(unsupportedAvif),true,'يجب تجهيز WebP إذا فشل فك AVIF فعلياً.');
const webpObjectUrl=await service.objectUrl(unsupportedAvif);
assert.equal(objectBlobs.get(webpObjectUrl)?.type,'image/webp','يجب اعتماد WebP بعد فشل AVIF.');
const unsupportedAvifAsset=unsupportedAvif.image.assets.find(asset=>asset.mimeType==='image/avif');
const supportedWebpAsset=unsupportedAvif.image.assets.find(asset=>asset.mimeType==='image/webp');
assert.equal(cachedResponses.has(service.requestUrlForAsset(unsupportedAvifAsset)),false,
  'صيغة AVIF التي فشل الجهاز في فكها يجب حذفها من CacheStorage.');
assert.equal(cachedResponses.has(service.requestUrlForAsset(supportedWebpAsset)),true,
  'صيغة WebP التي نجح فكها تبقى في CacheStorage للاستخدام اللاحق.');
assert.deepEqual(fetchedTypes.slice(unsupportedFetchStart,unsupportedFetchStart+2),['image/avif','image/webp'],
  'يجب تجربة AVIF أولاً ثم WebP.');
context.window.URL.revokeObjectURL(webpObjectUrl);

preflightRejectedTypes=new Set();
const renderFallback=testQuestionVariant(valid,'render-fallback');
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
const unavailable=testQuestionVariant(valid,'all-formats-unavailable');
await assert.rejects(service.prepareQuestion(unavailable),/decode_failed/,'لا يجوز اعتبار السؤال جاهزاً إذا فشل AVIF وWebP.');
assert.equal(service.isReady(unavailable),false);

preflightRejectedTypes=new Set();
context.window.Image=TestImage;
service.clearReadyCache();
cachedResponses.clear();
const lruQuestions=Array.from({length:service.MAX_READY_ASSET_COUNT+1},(_,index)=>
  testQuestionVariant(valid,`lru-${String(index).padStart(3,'0')}`));
await service.prepareQuestion(lruQuestions[0]);
for(const question of lruQuestions.slice(1,-1)) await service.prepareQuestion(question);
assert.equal(service.readyCacheStats().entries,service.MAX_READY_ASSET_COUNT,
  'ذاكرة Blob تبقى عند حد جولة كاملة قبل إضافة صورة أخرى.');
assert.equal(service.isReady(lruQuestions[0]),true,'قراءة صورة جاهزة يجب أن تحدّث موقعها في LRU.');
await service.prepareQuestion(lruQuestions.at(-1));
const lruStats=service.readyCacheStats();
assert.equal(lruStats.entries,service.MAX_READY_ASSET_COUNT,'إضافة صورة رقم 97 تخلي الأقدم بدل نمو الذاكرة.');
assert.ok(lruStats.bytes<=service.MAX_READY_ASSET_BYTES,'يجب تطبيق حد البايتات كذلك، ليس عدد الملفات فقط.');
assert.equal(service.isReady(lruQuestions[0]),true,'الصورة التي استُخدمت مؤخراً لا تُخلى أولاً.');
assert.equal(service.isReady(lruQuestions[1]),false,'الصورة الأقدم غير المستخدمة هي التي تُخلى.');
assert.equal(service.isReady(lruQuestions.at(-1)),true,'آخر صورة مجهزة تبقى في الذاكرة.');
assert.ok(cachedResponses.size<=service.MAX_PERSISTENT_CACHE_ENTRIES,
  'CacheStorage الدائم لا ينمو مع بنك الـ1500 سؤال؛ يحذف أقدم المدخلات best-effort.');
service.clearReadyCache();
assert.deepEqual(JSON.parse(JSON.stringify(service.readyCacheStats())),{
  entries:0,bytes:0,maxEntries:service.MAX_READY_ASSET_COUNT,maxBytes:service.MAX_READY_ASSET_BYTES,
},'يمكن تحرير ذاكرة صور الجولة كلها دون مس بنك الخادم.');

console.log('✓ صور الأسئلة: تحقق موثوق، مهلة وإلغاء، وذاكرة/CacheStorage محدودان');
