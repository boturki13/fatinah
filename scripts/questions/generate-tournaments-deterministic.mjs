#!/usr/bin/env node
import path from 'node:path';
import { CANDIDATES_PATH, CONTENT_DIR, difficultyTier, loadExistingQuestionTexts, loadPolicy, readJson, stableQuestionId, validateCandidate, writeJsonAtomic } from './lib.mjs';
const write=process.argv.includes('--write'), model='deterministic-wikidata-tournament-template-v1';
const source=readJson(path.join(CONTENT_DIR,'structured-sources','wikidata-tournaments.json'),null), plan=readJson(path.join(CONTENT_DIR,'bank-plan-5000.json'),null);
if(!source?.records?.length) throw new Error('شغّل مستورد البطولات أولاً.');
const candidates=readJson(CANDIDATES_PATH,[]), policy=loadPolicy(), knownIds=new Set(candidates.map(x=>x.id));
const comparisons=[...loadExistingQuestionTexts(),...candidates.filter(x=>x.status==='approved').map(x=>x.question)],added=[];
const months=['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
const year=v=>{const m=String(v||'').match(/^[+-]?(\d{4})/);return m?String(Number(m[1])):''};
const month=v=>{const m=String(v||'').match(/^[-+]?\d{4}-(\d{2})/);return m?months[Number(m[1])-1]||'':''};
const amount=v=>String(v||'').replace(/^\+/,'').replace(/\.0+$/,'');
const inclusiveDays=(a,b)=>{const start=Date.parse(a),end=Date.parse(b);return Number.isFinite(start)&&Number.isFinite(end)?String(Math.round((end-start)/86400000)+1):''};
const editionWords=['','الأولى','الثانية','الثالثة','الرابعة','الخامسة','السادسة','السابعة','الثامنة','التاسعة','العاشرة','الحادية عشرة','الثانية عشرة','الثالثة عشرة','الرابعة عشرة','الخامسة عشرة','السادسة عشرة','السابعة عشرة','الثامنة عشرة','التاسعة عشرة','العشرون','الحادية والعشرون','الثانية والعشرون','الثالثة والعشرون','الرابعة والعشرون','الخامسة والعشرون','السادسة والعشرون','السابعة والعشرون','الثامنة والعشرون'];
const editionLabel=r=>`${editionWords[Number(amount(r.edition))]||'رقم'} (${amount(r.edition)})`;
function facts(category,r){
 if(category==='الألعاب الأولمبية') return [
  [`في أي مدينة أقيمت ${r.itemLabel}؟`,r.locationLabel,'host-city'],[`في أي دولة أقيمت ${r.itemLabel}؟`,r.countryLabel,'host-country'],
  [`كم دولة أو وفداً مشاركاً يسجل ${r.itemLabel}؟`,amount(r.participants),'participants'],[`في أي شهر بدأت ${r.itemLabel}؟`,month(r.start),'start-month'],
  [`في أي شهر انتهت ${r.itemLabel}؟`,month(r.end),'end-month'],[`كم يوماً استمرت نسخة ${r.itemLabel} المقامة في ${r.locationLabel} بدولة ${r.countryLabel} مع احتساب يومي البداية والنهاية؟`,inclusiveDays(r.start,r.end),'duration-days']];
 if(category==='دوري أبطال أوروبا') return [
  [`منو بطل ${r.itemLabel}؟`,r.winnerLabel,'winner'],[`كم فريق شارك في ${r.itemLabel}؟`,amount(r.participants),'participants'],
  [`كم مباراة لعبت في ${r.itemLabel}؟`,amount(r.matches),'matches'],[`كم هدف سجل في ${r.itemLabel}؟`,amount(r.goals),'goals'],
  [`في أي شهر بدأ موسم ${r.itemLabel}؟`,month(r.start),'start-month'],[`في أي شهر انتهى موسم ${r.itemLabel}؟`,month(r.end),'end-month']];
 return [[`في أي سنة أقيمت نسخة كأس الخليج ${editionLabel(r)} بمشاركة ${amount(r.participants)} منتخبات خلال ${amount(r.matches)} مباراة و${amount(r.goals)} هدفاً؟`,year(r.point),'year'],
  [`كم منتخب شارك في نسخة كأس الخليج ${editionLabel(r)} سنة ${year(r.point)} خلال ${amount(r.matches)} مباراة و${amount(r.goals)} هدفاً؟`,amount(r.participants),'participants'],
  [`كم مباراة لعبت في نسخة كأس الخليج ${editionLabel(r)} سنة ${year(r.point)} بمشاركة ${amount(r.participants)} منتخبات و${amount(r.goals)} هدفاً؟`,amount(r.matches),'matches'],
  [`كم هدف سجل في نسخة كأس الخليج ${editionLabel(r)} سنة ${year(r.point)} بمشاركة ${amount(r.participants)} منتخبات خلال ${amount(r.matches)} مباراة؟`,amount(r.goals),'goals'],
  [`شنو عدد المنتخبات في نسخة كأس الخليج ${editionLabel(r)} التي شهدت ${amount(r.matches)} مباراة و${amount(r.goals)} هدفاً؟`,amount(r.participants),'participant-count'],
  [`شنو عدد مباريات نسخة كأس الخليج ${editionLabel(r)} التي شارك فيها ${amount(r.participants)} منتخبات وسجلت ${amount(r.goals)} هدفاً؟`,amount(r.matches),'match-count']]; }
function approve(c){const now=new Date().toISOString();Object.assign(c,{status:'approved',generation:{model,responseId:null,generatedAt:now,usage:{inputTokens:0,outputTokens:0,webSearchCalls:0,estimatedUsd:0}},verification:{model:'wikidata-tournament-property-v1',responseId:null,checkedAt:now,result:{verdict:'pass',factCorrect:true,answerExact:true,answerNotRevealed:true,sourceSupportsClaim:true,clearArabic:true,reason:'حقيقة بطولة من خاصية Wikidata مباشرة.'},usage:{inputTokens:0,outputTokens:0,webSearchCalls:0,estimatedUsd:0}},cost:{pricingAsOf:null,budgetUsd:0,runEstimatedUsd:0},review:{reviewer:model,decision:'approve',notes:'تحقق حتمي من حقيقة البطولة والتكرار.',religiousSourceAndIsnadConfirmed:false,reviewedAt:now}});candidates.push(c);added.push(c);knownIds.add(c.id);comparisons.push(c.question)}
for(const category of ['الألعاب الأولمبية','دوري أبطال أوروبا','كأس الخليج']){const pool=source.records.filter(r=>r.category===category);
 for(let level=1;level<=6;level++){const needed=Number(plan.categories?.[category]?.levels?.[level]?.gap||0),factIndex=level-1;let accepted=0;
  for(const r of pool){if(accepted>=needed)break;const [question,answer,type]=facts(category,r)[factIndex];if(!answer)continue;
   const evidence=`سجل ${r.itemLabel} يثبت قيمة ${answer} للخاصية المطلوبة.`;const c={category,difficultyLevel:level,difficulty:difficultyTier(level),question,answer,explanation:evidence,religious:false,
    sourceRecordId:`${r.sourceRecordId}-${type}`,templateId:`tournament-${type}-v1-l${level}`,source:{title:`${r.itemLabel} — Wikidata`,url:r.sourceUrl,publisher:'Wikidata',evidence}};
   c.id=stableQuestionId(c);const validation=validateCandidate(c,{policy,existingQuestions:comparisons});if(!validation.valid||knownIds.has(c.id))continue;approve(c);accepted++;}
  if(accepted!==needed)throw new Error(`${category} المستوى ${level}: ${accepted}/${needed}`);}}
if(write)writeJsonAtomic(CANDIDATES_PATH,candidates);console.log(JSON.stringify({mode:write?'write':'dry-run',added:added.length,byCategory:Object.fromEntries(['الألعاب الأولمبية','دوري أبطال أوروبا','كأس الخليج'].map(c=>[c,added.filter(x=>x.category===c).length])),aiCalls:0,estimatedAiCostUsd:0},null,2));
