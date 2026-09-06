import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';

const require=createRequire(import.meta.url);
const {
  filterLegacyGeneratedCandidates,
  legacyContentIsBlocked,
}=require('../functions/legacy-content-policy.js');

const blockedTopics=[
  'تاريخ إسرائيل', 'اسرائيلي', 'إســرائيل', 'إسراءيل',
  'Israel', 'Israeli cities', 'Isreal history', 'Israël', 'Tel-Aviv', 'ישראל',
  'محتوى إباحي', 'الإباحية', 'بورنوغرافي', 'pornography', 'NSFW', 'adult content',
];
for(const topic of blockedTopics){
  assert.equal(legacyContentIsBlocked(topic),true,'الحاجز يجب أن يرفض التهجئة المحظورة.');
}

for(const topic of [
  'تاريخ الكويت', 'علوم وطبيعة', 'الأدب العربي',
  'World geography', 'Zion National Park geology', 'التكاثر عند النباتات',
]){
  assert.equal(legacyContentIsBlocked(topic),false,'الموضوع العائلي السليم يجب أن يستمر.');
}

const safeQuestion={
  q:'ما عاصمة الكويت؟',answer:'مدينة الكويت',
  source:{title:'مرجع جغرافي',url:'https://example.org/kuwait'},
};
const filtered=filterLegacyGeneratedCandidates([
  {q:'سؤال عن إسرائيل؟',answer:'إجابة'},
  {q:'Safe looking question?',answer:'Tel Aviv'},
  {q:'سؤال ظاهره سليم؟',answer:'إجابة',source:{title:'Israel source',url:'https://example.org'}},
  {q:'Question?',answer:'pornographic material'},
  safeQuestion,
],12);
assert.deepEqual(filtered,[safeQuestion],'يجب تصفية السؤال أو الإجابة أو المصد المحظور قبل الإرجاع.');
assert.equal(legacyContentIsBlocked(filtered),false,'مخرج الحاجز نفسه لا يحتوي نصاً محظوراً.');

const functionSource=readFileSync(new URL('../functions/index.js',import.meta.url),'utf8');
const v1Handler=functionSource.split('async function generateQuestionsV1Handler',2)[1]
  .split('exports.generateQuestions = onRequest',1)[0];
assert.ok(v1Handler.indexOf('legacyContentIsBlocked(topic)')<v1Handler.indexOf('verifyIdToken'),
  'يجب رفض topic قبل التحققات الشبكية ومزود التوليد.');
assert.ok(v1Handler.indexOf('filterLegacyGeneratedCandidates')<v1Handler.indexOf('reachableTrustedSource'),
  'يجب تصفية مخرج المزود قبل فحص رابطه عبر الشبكة.');
assert.match(v1Handler,/questions = questions\.filter\(\(question\) => !legacyContentIsBlocked\(question\)\)/,
  'يجب إعادة فحص النتيجة النهائية بعد تطبيع المصد.');

console.log('✓ Functions v1 يرفض topic المحظور ويصفي السؤال/الإجابة بالعربية والإنجليزية');
