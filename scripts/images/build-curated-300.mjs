import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {familySafetyDecision} from './family-safety-policy.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const publishedBankPath=path.join(root,'server-assets/question-images/curated-question-bank.json');
function writeFileAtomic(target,contents){
  fs.mkdirSync(path.dirname(target),{recursive:true});
  const temporary=`${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary,contents,{mode:0o644});
  fs.renameSync(temporary,target);
}
const context={window:{},URL,Response,Headers,Blob,crypto:crypto.webcrypto,console};
context.globalThis=context.window;
for(const file of ['image-assets.js','image-question-bank.js','image-question-bank-commons.js']){
  vm.runInNewContext(fs.readFileSync(path.join(root,'www',file),'utf8'),context);
}

const bank=context.window.__IMAGE_QUESTION_BANK_DATA__;
const duplicateImageSourceIds=new Set(['img-v2-space-nasa-pia04921']);
const safeQuestions=(category,questions)=>questions.filter(question=>
  familySafetyDecision(category,question).allowed&&!duplicateImageSourceIds.has(question.id));

const normalizeOption=value=>String(value||'').normalize('NFKC').trim();
const genericSpaceKinds=new Set(['مجرة','سديم','كوكب','نجم','قمر']);
const genericSpaceAnswers=new Set([...genericSpaceKinds,'مذنب','قمر طبيعي']);
const imageOptionGroup=(category,question)=>category==='شنو بالفضاء؟'
  ?(genericSpaceAnswers.has(normalizeOption(question.answer))?'space-kind':'named-space-object')
  :category;
function semanticallyCompatibleOptions(category,answers){
  if(category!=='شنو بالفضاء؟') return true;
  const normalized=answers.map(normalizeOption);
  return normalized.every((answer,index)=>normalized.every((other,otherIndex)=>{
    if(index===otherIndex) return true;
    return !(genericSpaceKinds.has(answer)&&other.startsWith(`${answer} `));
  }));
}
const familiarCountries=[
  'الكويت','اليابان','كندا','البرازيل','الإمارات العربية المتحدة','الصين','فرنسا','المملكة المتحدة','ألمانيا','مصر',
  'إيطاليا','إسبانيا','الهند','الأردن','البحرين','المغرب','الجزائر','العراق','إيران','جنوب أفريقيا','أستراليا','اليونان',
  'كوريا الجنوبية','المكسيك','سويسرا','النمسا','بلجيكا','أيرلندا','إندونيسيا','ماليزيا','لبنان','الأرجنتين','تشيلي',
  'فنلندا','آيسلندا','كولومبيا','كوبا','كرواتيا','التشيك','نيوزيلندا','تايلاند','باكستان','بنغلاديش','نيبال','سريلانكا','كينيا','إثيوبيا',
  'غانا','الكاميرون','بلغاريا','أوكرانيا','روسيا','تركيا','البرتغال','هولندا','السويد','النرويج','الدنمارك','بولندا','صربيا','رومانيا',
  'كازاخستان','أذربيجان','أرمينيا','جورجيا','منغوليا','كمبوديا','فيجي','جامايكا','قبرص','مالطا','موناكو','ليبيا','موريتانيا','المالديف',
  'بوتان','موزمبيق','كيريباتي','دومينيكا','بليز','أندورا','ألبانيا','أنغولا','بوليفيا','بروناي','بوتسوانا','مدغشقر',
];
const countryRank=new Map(familiarCountries.map((answer,index)=>[answer,index]));
const flags=safeQuestions('أعلام منو؟',[...bank['أعلام منو؟']])
  .filter(question=>question.id!=='img-v2-flagx-q142') // صورة تاريخية لفرنسا وليست العلم الحالي.
  .sort((a,b)=>(countryRank.get(a.answer)??999)-(countryRank.get(b.answer)??999));
const familiarAnimals=[
  'الأسد','الزرافة','ببر','ذئب رمادي','نمر','فهد','فرس النهر','دب بني','ثعلب أحمر','الدب القطبي',
  'الباندا الأحمر','خلد الماء','تنين كومودو','خنزير بري','موظ','كوالا','أسد الجبال','رنة','حوت قاتل','حوت أزرق',
  'يغور','راكون شائع','سمك ذهبي','قيوط','جمل عربي','طاووس هندي','شمبانزي شائع','فيل آسيوي','سرقاط',
  'أبو مركوب','حوت الناروال','روبيان السرعوف','ظبي السايغا','الفوسا','تنين البحر الورقي','كابياء خنزيرية','عناق الأرض',
  'ثور المسك','وحيد القرن الأبيض','وحيد القرن الأسود','بيسون أمريكي','إمبالة','شيطان تسمانيا',
  'أصلوت','ثعلب قطبي','قندس أوراسي','قضاعة بحرية','غوناق',
];
const animalRank=new Map(familiarAnimals.map((answer,index)=>[answer,index]));
const animals=safeQuestions('شنو هالحيوان؟',[...bank['شنو هالحيوان؟']])
  .filter(question=>!['img-v2-animal-narwhal','img-v2-animalx-q79803'].includes(question.id))
  .sort((a,b)=>(animalRank.get(a.answer)??999)-(animalRank.get(b.answer)??999));
const familiarObjects=[
  'سيارة','حافلة','شاحنة','قطار','مروحية','سفينة','دراجة هوائية','دراجة نارية','كاميرا','هاتف','حاسوب محمول','تلفاز','سماعات رأس','لوحة مفاتيح','فأرة حاسوب','طابعة','كرسي','طاولة',
  'سيارة إسعاف','سيارة إطفاء','جرار زراعي','قارب شراعي','قارب كاياك','لوح تزلج','سكوتر','منطاد','منظار','مقراب','مجهر','بوصلة','ساعة حائط','ساعة منبّه','ساعة يد','مقياس حرارة','آلة حاسبة',
  'معداد','ماسح ضوئي','مكبر صوت','ميكروفون','جهاز تحكم','مصباح يدوي','مصباح كهربائي','مروحة','مطرقة','مفك براغي','مفتاح ربط','منشار يدوي','مثقاب','مجرفة','سلّم','حبل','سلسلة',
  'قفل','مفتاح','مقص','إبرة خياطة','سحّاب','دبّاسة','شريط قياس','ميزان ماء','سرير','أريكة','خزانة كتب','سجادة','وسادة','مظلة',
  'حقيبة سفر','حقيبة ظهر','سلّة','دلو','مكنسة','ممسحة','صحن','وعاء','كوب','كأس زجاجي','زجاجة','ملعقة',
  'شوكة','غلاية','إبريق شاي','مقلاة','مخفقة','شوبك','محمصة خبز','فرن ميكروويف','ثلاجة','خلّاط',
];
const objectRank=new Map(familiarObjects.map((answer,index)=>[answer,index]));
const objects=safeQuestions('شنو هالشي؟',[...bank['شنو هالشي؟']])
  .sort((a,b)=>((objectRank.get(a.answer)??999)-(objectRank.get(b.answer)??999))
    ||Number(b.id.includes('objectx-'))-Number(a.id.includes('objectx-')))
  .filter((question,index,array)=>array.findIndex(item=>item.answer===question.answer)===index);
const treasures=safeQuestions('كنوز الحضارات',bank['كنوز الحضارات'])
  .filter(question=>question.id.startsWith('img-v2-treasurex-'));
// كل صف يمثل فئة، وكل عمود مستوى. الحصص تضمن جولة كاملة لكل فئة
// (سؤالان على الأقل لكل مستوى) مع الإبقاء على 48 صورة v2 في كل مستوى.
const configs=[
  {category:'أعلام منو؟',questions:flags,quotas:[12,12,12,12,12,12]},
  {category:'وين هالمعلم؟',questions:safeQuestions('وين هالمعلم؟',bank['وين هالمعلم؟']),quotas:[4,4,4,4,4,4]},
  {category:'شنو هالحيوان؟',questions:animals,quotas:[8,8,8,8,8,8]},
  {category:'شنو بالفضاء؟',questions:safeQuestions('شنو بالفضاء؟',bank['شنو بالفضاء؟']),quotas:[6,6,6,6,6,6]},
  {category:'شنو هالشي؟',questions:objects,quotas:[14,14,14,14,14,14]},
  {category:'كنوز الحضارات',questions:treasures,quotas:[4,4,4,4,4,4]},
];
const selected=[];
for(const {category,questions,quotas} of configs){
  let offset=0;
  for(let difficulty=1;difficulty<=6;difficulty++){
    const count=quotas[difficulty-1];
    const candidates=questions.filter(question=>question.id.startsWith('img-v2-')).slice(offset,offset+count);
    if(candidates.length!==count) throw new Error(`${category}: صور غير كافية للمستوى ${difficulty}.`);
    for(const question of candidates){
      const safety=familySafetyDecision(category,question);
      if(!safety.allowed) throw new Error(`${question.id}: مرفوض حسب سياسة المحتوى (${safety.reason}).`);
    }
    selected.push(...candidates.map(question=>({category,question,difficulty})));
    offset+=count;
  }
}
for(let difficulty=1;difficulty<=6;difficulty++){
  const count=selected.filter(entry=>entry.difficulty===difficulty).length;
  if(count!==48) throw new Error(`المستوى ${difficulty}: المتوقع 48، الموجود ${count}.`);
}

function stableNumber(value){
  return Number.parseInt(crypto.createHash('sha256').update(value).digest('hex').slice(0,8),16);
}

const choices={};
const difficulties={};
for(const {category,question,difficulty} of selected){
  const optionGroup=imageOptionGroup(category,question);
  const sameLevel=selected.filter(entry=>entry.category===category&&entry.difficulty===difficulty
    &&imageOptionGroup(entry.category,entry.question)===optionGroup);
  const nearbyLevels=selected
    .filter(entry=>entry.category===category&&entry.difficulty!==difficulty
      &&imageOptionGroup(entry.category,entry.question)===optionGroup)
    .sort((a,b)=>Math.abs(a.difficulty-difficulty)-Math.abs(b.difficulty-difficulty));
  const answers=[...new Set([...sameLevel,...nearbyLevels].map(entry=>entry.question.answer))];
  const distractors=[];
  for(const answer of answers
    .filter(answer=>answer!==question.answer)
    .sort((a,b)=>stableNumber(`${question.id}:${a}`)-stableNumber(`${question.id}:${b}`))){
    if(semanticallyCompatibleOptions(category,[question.answer,...distractors,answer])) distractors.push(answer);
    if(distractors.length===3) break;
  }
  if(distractors.length!==3) throw new Error(`${question.id}: لا توجد مشتتات كافية.`);
  const options=[...distractors];
  options.splice(stableNumber(question.id)%4,0,question.answer);
  choices[question.id]=options;
  difficulties[question.id]=difficulty;
}

const releaseManifest=JSON.parse(fs.readFileSync(
  path.join(root,'server-assets/question-images/release-manifest.json'),'utf8'));
if(releaseManifest.status!=='published'){
  throw new Error('لا يمكن إعلان فئات الصور قبل أن يكون manifest الأصول منشوراً.');
}
const manifestAssetByKey=new Map(releaseManifest.items.map(item=>[
  `${item.questionId}\u0000${item.url}`,item,
]));
const publishedCategoryOrder=['تعرف على الصورة',...configs.map(config=>config.category)];
const selectedByCategory=new Map(configs.map(({category})=>[
  category,selected.filter(entry=>entry.category===category),
]));
const clone=value=>JSON.parse(JSON.stringify(value));
const publishedBank={};
const publishedIds=new Set();

for(const category of publishedCategoryOrder){
  const questions=category==='تعرف على الصورة'
    ?safeQuestions(category,bank[category]).filter(question=>question.id.startsWith('img-v1-')).map(clone)
    :(selectedByCategory.get(category)||[]).map(({question,difficulty})=>{
      const copy=clone(question);
      copy.d=difficulty;
      copy.o=[...choices[question.id]];
      copy.a=copy.o.indexOf(copy.answer);
      return copy;
    });
  for(const question of questions){
    if(publishedIds.has(question.id)) throw new Error(`${question.id}: معرّف صورة مكرر.`);
    publishedIds.add(question.id);
    const safety=familySafetyDecision(category,question);
    if(!safety.allowed) throw new Error(`${question.id}: مرفوض حسب سياسة المحتوى (${safety.reason}).`);
    if(question.review?.status!=='approved') throw new Error(`${question.id}: غير معتمد للنشر.`);
    if(!Array.isArray(question.o)||question.o.length!==4||new Set(question.o).size!==4
        ||question.o[question.a]!==question.answer){
      throw new Error(`${question.id}: عقد الخيارات الأربعة غير صالح.`);
    }
    if(!Array.isArray(question.image?.assets)||question.image.assets.length!==2){
      throw new Error(`${question.id}: يجب أن يحتوي AVIF وWebP.`);
    }
    for(const asset of question.image.assets){
      const manifestAsset=manifestAssetByKey.get(`${question.id}\u0000${asset.url}`);
      if(!manifestAsset||manifestAsset.sha256!==asset.sha256||manifestAsset.bytes!==asset.bytes
          ||manifestAsset.mimeType!==asset.mimeType){
        throw new Error(`${question.id}: الأصل لا يطابق manifest المنشور.`);
      }
    }
  }
  for(let difficulty=1;difficulty<=6;difficulty++){
    const count=questions.filter(question=>question.d===difficulty).length;
    if(count<2) throw new Error(`${category}: المستوى ${difficulty} لا يكفي لجولة من سؤالين.`);
  }
  publishedBank[category]=questions;
}

const publishedQuestions=Object.values(publishedBank).flat();
if(selected.length!==288||publishedQuestions.length!==300){
  throw new Error(`عدد صور النشر غير صالح: ${publishedQuestions.length}/300.`);
}
const publishedImageHashes=new Set();
for(const question of publishedQuestions){
  const canonicalHash=question.image.assets.find(asset=>asset.mimeType==='image/webp')?.sha256;
  if(!canonicalHash||publishedImageHashes.has(canonicalHash)) {
    throw new Error(`${question.id}: صورة مكررة بصريًا داخل بنك النشر.`);
  }
  publishedImageHashes.add(canonicalHash);
}
const bankSha256=crypto.createHash('sha256').update(JSON.stringify(publishedBank)).digest('hex');
const assetRecords=publishedQuestions.flatMap(question=>question.image.assets.map(asset=>({
  questionId:question.id,
  url:asset.url,
  mimeType:asset.mimeType,
  bytes:asset.bytes,
  sha256:asset.sha256,
})));
const assetsSha256=crypto.createHash('sha256').update(JSON.stringify(assetRecords)).digest('hex');
const reviewedDates=publishedQuestions.map(question=>String(question.review?.reviewedAt||''))
  .filter(value=>/^\d{4}-\d{2}-\d{2}$/u.test(value)).sort();
if(!reviewedDates.length) throw new Error('تاريخ مراجعة صور النشر مفقود.');
const distribution=Object.fromEntries(publishedCategoryOrder.map(category=>[category,{
  count:publishedBank[category].length,
  levels:Object.fromEntries(Array.from({length:6},(_,index)=>index+1).map(level=>[
    level,publishedBank[category].filter(question=>question.d===level).length,
  ])),
}]));
const bankMetadata={
  schemaVersion:1,
  questionSchemaVersion:1,
  bankVersion:`images-v4-curated-${bankSha256.slice(0,16)}`,
  generatedAt:`${reviewedDates.at(-1)}T00:00:00.000Z`,
  sha256:bankSha256,
  assetsSha256,
  questionCount:publishedQuestions.length,
  categoryCount:publishedCategoryOrder.length,
  assetCount:assetRecords.length,
  targetBankSize:300,
  questionsPerLevel:2,
  ready:true,
  releaseReady:true,
  publishedCategories:publishedCategoryOrder,
  distribution,
};
const publishedBankDocument={...bankMetadata,categories:publishedBank};

const serialized=JSON.stringify(choices,null,2);
const output=`// Generated by scripts/images/build-curated-300.mjs — do not edit manually.\n(function installCuratedImageOptions(global){\n  'use strict';\n  const choicesById=${serialized};\n  const difficulties=${JSON.stringify(difficulties,null,2)};\n  const bank=global.__IMAGE_QUESTION_BANK_DATA__||{};\n  for(const questions of Object.values(bank)){\n    for(const question of questions){\n      const options=choicesById[question.id];\n      if(!options) continue;\n      const correctIndex=options.indexOf(question.answer);\n      if(correctIndex<0) throw new Error(\`${'${question.id}'}: الإجابة الصحيحة غير موجودة ضمن الخيارات.\`);\n      question.o=[...options];\n      question.a=correctIndex;\n    }\n  }\n  global.__CURATED_IMAGE_OPTION_IDS__=Object.freeze(Object.keys(choicesById));\n  global.__CURATED_IMAGE_DIFFICULTIES__=Object.freeze(difficulties);\n  global.__RELEASED_IMAGE_CATEGORIES__=Object.freeze(${JSON.stringify(publishedCategoryOrder)});\n  global.__CURATED_IMAGE_BANK_METADATA__=Object.freeze(${JSON.stringify(bankMetadata)});\n})(typeof window!=='undefined'?window:globalThis);\n`;

for(const target of ['www/curated-image-options.js','ios/App/App/public/curated-image-options.js']){
  writeFileAtomic(path.join(root,target),output);
}
writeFileAtomic(publishedBankPath,`${JSON.stringify(publishedBankDocument,null,2)}\n`);
console.log(`Generated ${publishedQuestions.length} published image questions across ${publishedCategoryOrder.length} complete categories.`);
