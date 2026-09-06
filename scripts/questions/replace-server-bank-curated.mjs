#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CANDIDATES_PATH, ROOT, familyContentViolations, loadPolicy, loadReligiousSourcePackets, readJson, validateCandidate, writeJsonAtomic } from './lib.mjs';

const TARGET=1500;
const outputDirectory=path.join(ROOT,'server-assets','question-bank','v1');
const bankPath=path.join(outputDirectory,'bank.json');
const manifestPath=path.join(outputDirectory,'manifest.json');
const reportPath=path.join(outputDirectory,'curation-report.json');
const archiveDirectory=path.join(ROOT,'server-assets','question-bank','archive');
const policy=loadPolicy();
const religiousPackets=loadReligiousSourcePackets();
const mintakaDocument=readJson(path.join(ROOT,'content','questions','structured-sources','mintaka-ar.json'),null);

// لا ينشر القسم الديني إلا ما يطابق حزمة قرآن ثابتة ومراجعة. تُعوض فجوة
// 80 سؤالاً بالحضارات مؤقتاً إلى أن تكتمل المراجعة البشرية المنفصلة.
const quotas={
  'إجابة سريعة':150,'ألغاز وتحدّي ذكاء':150,'أعلام الدول':100,
  'اللغة العربية':68,
  'ثقافة خليجية':100,'مسلسلات خليجية':100,'أغاني خليجية':100,
  'القرآن الكريم':20,
};
const groups={
  global:new Set(['إجابة سريعة','ألغاز وتحدّي ذكاء','أعلام الدول']),
  arabic:new Set(['اللغة العربية']),
  gulf:new Set(['ثقافة خليجية','مسلسلات خليجية','أغاني خليجية']),
  religious:new Set(['القرآن الكريم']),
};
const seedSource={title:'Open Trivia DB — History',url:'https://opentdb.com/api_config.php',publisher:'Open Trivia Database',license:'CC BY-SA 4.0'};
const seedRows=[
  [1,'ما المدينة التي فتحها العثمانيون عام 1453؟',['القسطنطينية','روما','أثينا','هامبورغ'],0],
  [1,'ألقت الولايات المتحدة قنبلتين ذريتين على هيروشيما وأي مدينة يابانية أخرى عام 1945؟',['ناغازاكي','طوكيو','كاواساكي','كاغوشيما'],0],
  [2,'كم سنة استمرت الحرب العالمية الثانية؟',['أربع سنوات','خمس سنوات','ست سنوات','سبع سنوات'],2],
  [2,'بماذا تحتفل الولايات المتحدة في الرابع من يوليو؟',['توقيع إعلان الاستقلال','نهاية الحرب الأهلية','اعتماد الدستور','تأسيس مدينة واشنطن'],0],
  [3,'ما الدولة التي انضمت إلى الاتحاد الأوروبي عام 2013؟',['كرواتيا','بلغاريا','سلوفينيا','تركيا'],0],
  [3,'من الإمبراطور الروماني الذي بلغت الإمبراطورية في عهده أكبر امتداد جغرافي؟',['تراجان','يوليوس قيصر','كلوديوس','قسطنطين الأكبر'],0],
  [4,'في أي عام نالت جامايكا استقلالها عن بريطانيا؟',['1949','1962','1963','1987'],1],
  [4,'ما اسم زعيم الأباتشي الشهير الذي توفي عام 1909؟',['جيرونيمو','سيتينغ بول','ريد كلاود','كريزي هورس'],0],
  [5,'إلى أي معسكر سياسي انضم فرانسيسكو فرانكو خلال الحرب الأهلية الإسبانية؟',['القوميون','الجمهوريون','الجبهة الشعبية','الدولة البابوية'],0],
  [5,'في أي عام وقع هجوم غاز السارين في مترو طوكيو؟',['1991','1995','2001','2011'],1],
  [6,'أي واحد من هؤلاء الحكام لم ينتمِ إلى أسرة هابسبورغ؟',['شارل الخامس','فيليب الثاني','فيليب الخامس','فرانتس يوزف'],2],
  [6,'كم يومًا استمرت انتفاضة وارسو خلال الحرب العالمية الثانية؟',['20 يومًا','55 يومًا','63 يومًا','224 يومًا'],2],
];
const bannedQualityPatterns=[/رقم (?:المباراة|السجل|المكوّن|المكون)/u,/حسب السجل/u,/رمز ISO/iu,/إحداثي|خط العرض|خط الطول/u,/أدرجت اليونسكو/u,/الكوكب الخارجي/u,/المعرّف\s*[A-Z]?\d+/iu,/Q\d{3,}/u,/\b[A-Z]{2,5}-?\d{3,}\b/u];

function qualityEligible(candidate){
  if(candidate.status!=='approved'||!(candidate.category in quotas)) return false;
  if(bannedQualityPatterns.some(pattern=>pattern.test(`${candidate.question} ${candidate.answer}`))) return false;
  if(candidate.category==='اللغة العربية'&&!candidate.templateId)return false;
  const validation=validateCandidate(candidate,{policy,existingQuestions:[],religiousSourcePackets:religiousPackets});
  if(!validation.valid) return false;
  if(candidate.category==='القرآن الكريم') return candidate.review?.religiousSourceAndIsnadConfirmed===true&&candidate.review?.religiousCanonicalSourceConfirmed===true&&candidate.review?.religiousNoDisputedMatterConfirmed===true;
  return true;
}
function stableRank(candidate){return crypto.createHash('sha256').update(`${candidate.category}|${candidate.difficultyLevel}|${candidate.id}`).digest('hex');}
function balancedSelect(rows,total){
  const levels=new Map([1,2,3,4,5,6].map(level=>[level,rows.filter(row=>Number(row.difficultyLevel)===level).sort((a,b)=>stableRank(a).localeCompare(stableRank(b)))]));
  const selected=[];
  while(selected.length<total){let progressed=false;for(let level=1;level<=6&&selected.length<total;level++){const row=levels.get(level).shift();if(row){selected.push(row);progressed=true;}}if(!progressed)break;}
  return selected;
}
function templateFamily(candidate){return String(candidate.templateId||candidate.generation?.model||'editorial').replace(/-l[1-6]$/,'');}
function answerShape(value){const text=String(value).trim();if(/^\d{4}$/.test(text))return'year';if(/^\d+(?:[.,]\d+)?(?:\s|$)/.test(text))return'number';if(/^سورة\s/u.test(text))return'surah';return'text';}
function digest(value){return crypto.createHash('sha256').update(value).digest('hex');}
function semanticFamily(candidate){
  const question=String(candidate.question);
  if(/فريق|منتخب|نادٍ|نادي |أي فرقة|ما الفرقة/u.test(question))return'group';
  if(/في أي دولة|في أي بلد|أي دولة|الدول التالية|الدولة الحديثة|يرجع لأي دولة|الدولة التي/u.test(question))return'country';
  if(/^(?:من|مين|منو)(?:\s|[؟])|مؤلف|مخترع|أدى|أخرج|صاحب|العالِم|العالم الذي|أم |أبو /u.test(question))return'person';
  if(/عاصمة|أي مدينة|ما المدينة|مدينة ماذا/u.test(question))return'city';
  if(/أي سنة|في أي عام|متى|سنة كم/u.test(question))return'year';
  if(/كم|احسب|الرقم التالي|ناتج/u.test(question))return'number';
  if(/مفرد|جمع|مرادف|ضد كلمة|المصدر من/u.test(question))return'word-form';
  if(/كيف تُكتب|أي الكلمتين|أي الكتابتين|الهمزة|كتابة معيارية/u.test(question))return'orthography';
  if(/التصنيف المعجمي/u.test(question))return'lexical-category';
  if(/نهر/u.test(question))return'river';
  if(/أين يقع|أين تقع|المكان الذي|في أي قارة/u.test(question))return'place';
  if(/إمبراطورية|حضارة|مملكة/u.test(question))return'civilization';
  if(/ما (?:هو |هي )?(?:الكتاب|الرواية|الفيلم|الأغنية|اللعبة)|اسم (?:الكتاب|الرواية|الفيلم|الأغنية|اللعبة)|أي (?:كتاب|رواية|فيلم|أغنية|لعبة)/u.test(question))return'work';
  if(/مكوّن|مكونات|نوع الأرز|نوع الماء|المشروب|المادة|بهار|التوابل/u.test(question))return'food';
  if(/سورة/u.test(question))return'surah';
  return answerShape(candidate.answer);
}
function nearbyNumericOptions(answer){
  const match=String(answer).trim().match(/^(\d+)(.*)$/u);if(!match)return null;
  const value=Number(match[1]),suffix=match[2];if(!Number.isSafeInteger(value))return null;
  const step=value>=1000?1:value>=100?10:value>=20?2:1;
  return [...new Set([Math.max(0,value-step),value+step,Math.max(0,value-step*2),value+step*2])].filter(item=>item!==value).slice(0,3).map(item=>`${item}${suffix}`);
}
function chooseDistractors(candidate,selected){
  const answer=String(candidate.answer).trim(),family=templateFamily(candidate),shape=answerShape(answer),semantic=semanticFamily(candidate),choices=[];
  if(shape==='number'||shape==='year'){
    const nearby=nearbyNumericOptions(answer);if(nearby?.length===3)return nearby;
  }
  const tiers=[row=>row.category===candidate.category&&semanticFamily(row)===semantic&&templateFamily(row)===family,row=>row.category===candidate.category&&semanticFamily(row)===semantic,row=>semanticFamily(row)===semantic&&answerShape(row.answer)===shape,row=>row.category===candidate.category&&answerShape(row.answer)===shape,row=>answerShape(row.answer)===shape];
  for(const predicate of tiers){
    const pool=[...new Set(selected.filter(row=>row.id!==candidate.id&&predicate(row)).map(row=>String(row.answer).trim()))].filter(value=>value&&value!==answer).sort((a,b)=>digest(`${candidate.id}|${a}`).localeCompare(digest(`${candidate.id}|${b}`)));
    for(const value of pool){if(!choices.includes(value))choices.push(value);if(choices.length===3)return choices;}
  }
  throw new Error(`تعذر إنشاء مشتتات متجانسة: ${candidate.id}`);
}
function groupFor(category){return Object.entries(groups).find(([,categories])=>categories.has(category))?.[0]||'unknown';}

const mintakaCategoryMap={history:'تاريخ',sports:'رياضة',geography:'جغرافيا',videogames:'ألعاب الفيديو',books:'كتب وروايات',music:'معلومات عامة',movies:'معلومات عامة'};
const mintakaComplexityLevels={generic:[1,2],count:[3,4],comparative:[3,4],superlative:[5,6],ordinal:[5,6],multihop:[5,6],intersection:[5,6],difference:[5,6]};
const preferredEntityClasses=['Q5','Q6256','Q571','Q11424','Q482994','Q7366','Q7889','Q12973014','Q847017','Q515','Q532','Q4022','Q16521','Q968159','Q198'];
function entityClassFamily(record){return preferredEntityClasses.find(id=>(record.answerClassIds||[]).includes(id))||record.answerClassIds?.[0]||'untyped';}
function mintakaCandidate(record){
  const levels=mintakaComplexityLevels[record.complexityType]||[3,4];
  const level=levels[parseInt(digest(record.id).slice(0,2),16)%levels.length];
  const classFamily=record.answerType==='entity'?entityClassFamily(record):record.answerType;
  return{id:`gq-${digest(record.id).slice(0,20)}`,category:mintakaCategoryMap[record.category],mintakaCategory:record.category,difficultyLevel:level,question:String(record.question).replace(/[?]$/u,'؟'),answer:String(record.answer),answerType:record.answerType,answerEntityId:record.answerEntityId||null,answerClassIds:record.answerClassIds||[],entityClassFamily:classFamily,templateId:`mintaka-${record.category}-${record.answerType}-${classFamily}`,source:{title:`Mintaka — ${record.category}`,url:record.sourceUrl,publisher:'Amazon Science',license:'CC BY 4.0',evidence:`Mintaka record ${record.sourceRecordId}`},generation:{model:'professionally-translated-mintaka'},review:{reviewer:'Mintaka professional translation + Fatinah release gate',reviewedAt:mintakaDocument.retrievedAt}};
}
function mintakaEligible(record){
  if(!(record.category in mintakaCategoryMap))return false;
  const candidate=mintakaCandidate(record),text=`${candidate.question} ${candidate.answer}`;
  if(candidate.question.length<12||candidate.question.length>180||candidate.answer.length>80)return false;
  if(/حالياً|حاليا|حتى الآن|الأحدث|آخر موسم|ألعابهم الوطنية|لم يكن مستقيم|مثلي(?:ة|اً|ا)?|202[0-9]/u.test(text))return false;
  if(bannedQualityPatterns.some(pattern=>pattern.test(text)))return false;
  return familyContentViolations(candidate,policy).length===0;
}

const allCandidates=readJson(CANDIDATES_PATH,[]);
const candidates=allCandidates.filter(qualityEligible);
const selected=[];
const shortages={};
for(const [category,target] of Object.entries(quotas)){
  const picked=balancedSelect(candidates.filter(candidate=>candidate.category===category),target);
  if(picked.length!==target)shortages[category]={target,available:picked.length};
  selected.push(...picked);
}
if(Object.keys(shortages).length)throw new Error(`مصادر غير كافية للحصص: ${JSON.stringify(shortages)}`);

if(!mintakaDocument||mintakaDocument.license!=='CC BY 4.0')throw new Error('مصدر Mintaka العربي غير مستورد أو ترخيصه غير مثبت.');
const mintakaSelected=[];
for(const upstreamCategory of Object.keys(mintakaCategoryMap)){
  const pool=mintakaDocument.records.filter(record=>record.category===upstreamCategory&&mintakaEligible(record)).map(mintakaCandidate);
  const picked=balancedSelect(pool,100);
  if(picked.length!==100)throw new Error(`Mintaka ${upstreamCategory}: ${picked.length}/100`);
  mintakaSelected.push(...picked);
}
const typeCachePath=path.join(ROOT,'content','questions','structured-sources','mintaka-answer-types.json');
const typeCache=readJson(typeCachePath,{schemaVersion:1,types:{}});
const missing=[...new Set(mintakaSelected.map(item=>item.answerEntityId).filter(id=>/^Q\d+$/.test(id)&&!typeCache.types[id]))];
const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
for(let offset=0;offset<missing.length;offset+=50){
  const ids=missing.slice(offset,offset+50),params=new URLSearchParams({action:'wbgetentities',ids:ids.join('|'),props:'claims',format:'json',origin:'*'});
  let result=null;
  for(let attempt=0;attempt<7&&!result;attempt++){
    const response=await fetch(`https://www.wikidata.org/w/api.php?${params}`,{headers:{'User-Agent':'FatinahQuestionBank/1.3 (question source audit)'}});
    if(response.ok)result=await response.json();
    else if(response.status===429||response.status>=500)await wait(1500*(attempt+1));
    else throw new Error(`تعذر إثراء Mintaka: HTTP ${response.status}`);
  }
  if(!result)throw new Error('تعذر إثراء أنواع إجابات Mintaka بعد إعادة المحاولة.');
  for(const [id,entity] of Object.entries(result.entities||{}))typeCache.types[id]=[...new Set((entity.claims?.P31||[]).map(claim=>claim?.mainsnak?.datavalue?.value?.id).filter(Boolean))].sort();
  await wait(750);
}
typeCache.retrievedAt=new Date().toISOString();
writeJsonAtomic(typeCachePath,typeCache);
for(const candidate of mintakaSelected){candidate.answerClassIds=typeCache.types[candidate.answerEntityId]||[];candidate.entityClassFamily=entityClassFamily(candidate);candidate.templateId=`mintaka-${candidate.mintakaCategory}-${candidate.answerType}-${candidate.entityClassFamily}`;}
selected.push(...mintakaSelected);

const questions=selected.map(candidate=>{
  const options=chooseDistractors(candidate,selected),correctIndex=parseInt(digest(candidate.id).slice(0,8),16)%4;options.splice(correctIndex,0,String(candidate.answer).trim());
  const cleanedQuestion=String(candidate.question).trim().replace(/\s+في السجل(?=؟)/u,'').replace(/في سجل المفردات العربية/u,'في المعجم العربي').replace(/في سجل التراث العالمي/u,'في قائمة التراث العالمي');
  const mintaka=Boolean(candidate.mintakaCategory);
  return{id:candidate.id,d:Number(candidate.difficultyLevel),band:Number(candidate.difficultyLevel)<=2?'easy':Number(candidate.difficultyLevel)<=4?'medium':'hard',q:cleanedQuestion,o:options,a:correctIndex,answer:String(candidate.answer).trim(),explanation:String(candidate.explanation||'').trim(),source:{...candidate.source},sourcePacketId:candidate.sourcePacketId||null,editorialGroup:mintaka?'global':groupFor(candidate.category),review:{status:'approved',reviewer:String(candidate.review?.reviewer||'Fatinah source review'),reviewedAt:candidate.review?.reviewedAt||null,basis:mintaka?'mintaka_professional_translation_plus_release_gate':'strict_v2_release_filter',religiousHumanReviewComplete:candidate.category==='القرآن الكريم'},category:candidate.category};
});
const reviewedQuran=questions.filter(question=>question.category==='القرآن الكريم').sort((a,b)=>a.q.length-b.q.length||a.id.localeCompare(b.id));
reviewedQuran.forEach((question,index)=>{question.d=1+Math.floor(index*6/reviewedQuran.length);question.band=question.d<=2?'easy':question.d<=4?'medium':'hard';});
for(const [d,q,o,a] of seedRows){const id=`gq-${digest(JSON.stringify({category:'تاريخ',d,q,o,a})).slice(0,20)}`;questions.push({id,d,band:d<=2?'easy':d<=4?'medium':'hard',q,o,a,answer:o[a],source:{...seedSource},sourcePacketId:null,editorialGroup:'global',review:{status:'approved',reviewer:'Fatinah curated import',reviewedAt:'2026-09-04',basis:'curated_opentdb_translation',religiousHumanReviewComplete:false},category:'تاريخ'});}
if(questions.length!==TARGET)throw new Error(`حجم البنك ${questions.length}/${TARGET}`);
const ids=new Set();
for(const question of questions){if(ids.has(question.id))throw new Error(`معرّف مكرر: ${question.id}`);ids.add(question.id);if(question.o.length!==4||new Set(question.o).size!==4||question.answer!==question.o[question.a])throw new Error(`خيارات غير صالحة: ${question.id}`);const violations=familyContentViolations(question,policy);if(violations.length)throw new Error(`محتوى محظور: ${question.id} ${violations.join(',')}`);}

const categories={};
for(const question of questions){const{category,...runtime}=question;(categories[category]??=[]).push(runtime);}
for(const rows of Object.values(categories))rows.sort((a,b)=>a.d-b.d||a.id.localeCompare(b.id));
for(const[category,rows]of Object.entries(categories)){if(new Set(rows.map(row=>row.d)).size!==6)throw new Error(`${category}: لا يغطي المستويات الستة`);}
const canonical=JSON.stringify(categories),bankDigest=digest(canonical),generatedAt=new Date().toISOString(),bankVersion=`v2-curated-${bankDigest.slice(0,16)}`;
const distribution=Object.fromEntries(Object.entries(categories).map(([category,rows])=>[category,{count:rows.length,levels:Object.fromEntries([1,2,3,4,5,6].map(level=>[level,rows.filter(row=>row.d===level).length]))}]));
const sourceMix={mintakaGlobal:700,deterministicGames:300,countryFlags:100,arabicLanguage:68,gulf:300,religiousReviewed:20,curatedOpenTriviaHistory:12,religiousPendingHumanReview:80};

fs.mkdirSync(archiveDirectory,{recursive:true});
if(fs.existsSync(bankPath)){const previous=readJson(bankPath,null),prefix=`${previous?.bankVersion||'unknown'}-${previous?.questionCount||'unknown'}`;for(const[sourcePath,suffix]of[[bankPath,'bank.json'],[manifestPath,'manifest.json']]){const destination=path.join(archiveDirectory,`${prefix}-${suffix}`);if(fs.existsSync(sourcePath)&&!fs.existsSync(destination))fs.copyFileSync(sourcePath,destination);}}
writeJsonAtomic(bankPath,{schemaVersion:1,bankVersion,generatedAt,sha256:bankDigest,questionCount:TARGET,targetBankSize:TARGET,ready:true,categories});
writeJsonAtomic(manifestPath,{schemaVersion:1,bankVersion,generatedAt,sha256:bankDigest,questionCount:TARGET,categoryCount:Object.keys(categories).length,excludedCount:allCandidates.length-selected.length,religiousExcludedPendingFullReview:80,targetBankSize:TARGET,ready:true,sourceMix,distribution});
writeJsonAtomic(reportPath,{schemaVersion:1,bankVersion,generatedAt,qualityRules:{fourUniqueOptions:true,sixDifficultyLevels:true,familyContentPolicy:true,opaqueIdentifiersBlocked:true,volatileFactsBlocked:true,sourceValidation:true},sourceMix,distribution});
console.log(JSON.stringify({bankVersion,questionCount:TARGET,categoryCount:Object.keys(categories).length,sourceMix},null,2));
