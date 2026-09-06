import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  PEOPLE_LITERATURE_CATEGORIES, verifyPeopleLiteratureQuestion,
} from '../scripts/questions/categories/people-literature.mjs';
import {
  MEDIA_TECH_GLOBAL_CATEGORIES, verifyMediaTechGlobalQuestionFact,
} from '../scripts/questions/categories/media-tech-global.mjs';
import {
  GULF_AVIATION_CATEGORIES, verifyGulfAviationQuestion,
} from '../scripts/questions/categories/gulf-aviation.mjs';
import { verifyWorldScienceQuestion } from '../scripts/questions/categories/world-science.mjs';
import { verifyProverbQuestion } from '../scripts/questions/categories/proverbs.mjs';
import { approveVerifiedQuestions, verifyQuestionBankFacts } from '../scripts/questions/factual-verifier.mjs';

const read = relative => JSON.parse(fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const document = read('server-assets/question-bank/v1/bank.json');
const ledger = read('content/questions/next-release-factual-ledger.json');
const expandedCategories = new Set([
  'كرة القدم العالمية', 'معلومات عامة', 'تاريخ وتراث الخليج', 'الفن الخليجي والعربي',
  'ألعاب الفيديو', 'تاريخ وحضارات', 'جسم الإنسان والصحة', 'مطابخ العالم',
  'سيارات ومركبات', 'اللغة العربية والأمثال',
]);
const baseCategories = Object.fromEntries(Object.entries(document.categories)
  .filter(([category]) => !expandedCategories.has(category)));
const verifierFiles = [
  'scripts/questions/categories/common.mjs',
  'scripts/questions/categories/people-literature.mjs',
  'scripts/questions/categories/media-tech-global.mjs',
  'scripts/questions/categories/gulf-aviation.mjs',
  'scripts/questions/categories/world-science.mjs',
  'scripts/questions/categories/proverbs.mjs',
];
const customVerifier = (question, record) => {
  if (PEOPLE_LITERATURE_CATEGORIES.includes(question.category)) {
    return verifyPeopleLiteratureQuestion(question, record);
  }
  if (MEDIA_TECH_GLOBAL_CATEGORIES.includes(question.category)) {
    return verifyMediaTechGlobalQuestionFact(question, record);
  }
  if (GULF_AVIATION_CATEGORIES.includes(question.category)) {
    return verifyGulfAviationQuestion(question, record);
  }
  if (question.category === 'اكتشف الكلمة') return verifyProverbQuestion(question, record);
  return verifyWorldScienceQuestion(question, record);
};

assert.equal(document.releaseReady, true);
const recomputed = verifyQuestionBankFacts(baseCategories, { customVerifier, verifierFiles });
assert.deepEqual(recomputed, ledger, 'سجل التحقق المنشور يجب أن يُعاد إنتاجه حرفيًا من البنك والمصادر والمدققات الحالية.');

const sample = category => clone(document.categories[category][0]);
const rejectsVerification = (label, category, question) => {
  assert.throws(
    () => verifyQuestionBankFacts({ [category]: [question] }, { customVerifier, verifierFiles }),
    undefined,
    `${label}: يجب أن يرفض مدقق الحقائق العبث.`,
  );
};

{
  const category = 'من أنا؟';
  const question = sample(category);
  question.q = `${question.q} (نص معدّل)`;
  rejectsVerification('تغيير نص سؤال الأشخاص', category, question);
}
{
  const category = 'تقنية وإنترنت';
  const question = sample(category);
  const distractorIndex = [0, 1, 2, 3].find(index => index !== question.a);
  question.o[distractorIndex] = 'جهة تقنية بديلة';
  rejectsVerification('تغيير مشتت موثق', category, question);
}
{
  const category = 'الكويت';
  const question = sample(category);
  question.source.url = 'https://www.wikidata.org/wiki/Q42';
  rejectsVerification('استبدال الرابط برابط موثوق لكنه غير متعلق', category, question);
}
{
  const category = 'مدن وعواصم';
  const question = sample(category);
  question.sourceRecordId = `${question.sourceRecordId}-tampered`;
  rejectsVerification('تبديل هوية سجل المصدر', category, question);
}
{
  const category = 'عملات العالم';
  const question = sample(category);
  const field = Object.keys(question.verification.fields)[0];
  const original = question.verification.fields[field];
  question.verification.fields[field] = typeof original === 'number' ? original + 1 : `${original}-tampered`;
  rejectsVerification('تبديل لقطة حقل المصدر', category, question);
}
{
  const category = 'أندية ومنتخبات';
  const question = sample(category);
  question.id = 'gq-00000000000000000000';
  rejectsVerification('تبديل المعرف الحتمي', category, question);
}
{
  const category = 'اختر العبارة الصحيحة';
  const question = sample(category);
  question.truthClaims[0].presentedValue = '__tampered__';
  rejectsVerification('تغيير برهان الزوج الصحيح', category, question);
}
{
  const category = 'ألغاز بوليسية';
  const question = sample(category);
  question.logicStatements[0].subject = (question.logicStatements[0].subject + 1) % 4;
  rejectsVerification('تغيير بنية اللغز بعد حله', category, question);
}
{
  const category = 'اكتشف الكلمة';
  const question = sample(category);
  const distractorIndex = [0, 1, 2, 3].find(index => index !== question.a);
  question.o[distractorIndex] = 'بصياغة معدلة';
  rejectsVerification('تغيير مشتت المثل', category, question);
}
{
  const category = 'فيزياء وكيمياء';
  const question = sample(category);
  const answerIndex = question.a;
  const distractorIndex = [0, 1, 2, 3].find(index => index !== answerIndex);
  question.a = distractorIndex;
  question.answer = question.o[distractorIndex];
  rejectsVerification('تغيير الإجابة مع إبقاء البنية قابلة للعب', category, question);
}

assert.doesNotThrow(() => approveVerifiedQuestions(clone(baseCategories), clone(ledger), { verifierFiles }));
{
  const changed = clone(baseCategories);
  const first = Object.values(changed)[0][0];
  first.difficultyBasis = `${first.difficultyBasis || 'rank'}-tampered`;
  assert.throws(() => approveVerifiedQuestions(changed, clone(ledger), { verifierFiles }),
    /سجل التحقق لا يطابق/u, 'أي تغيير في بيانات السؤال بعد بناء السجل يجب أن يلغي الاعتماد.');
}
{
  const changedLedger = clone(ledger);
  const artifact = Object.keys(changedLedger.artifacts)[0];
  changedLedger.artifacts[artifact] = '0'.repeat(64);
  assert.throws(() => approveVerifiedQuestions(clone(baseCategories), changedLedger, { verifierFiles }),
    /سجل التحقق لا يطابق/u, 'تغيير بصمة لقطة المصدر يجب أن يلغي الاعتماد.');
}
{
  const changedLedger = clone(ledger);
  changedLedger.verifierBundleSha256 = '0'.repeat(64);
  assert.throws(() => approveVerifiedQuestions(clone(baseCategories), changedLedger, { verifierFiles }),
    /سجل التحقق لا يطابق/u, 'تغيير حزمة المدققات يجب أن يلغي الاعتماد.');
}
{
  const changedLedger = clone(ledger);
  changedLedger.policySha256 = '0'.repeat(64);
  assert.throws(() => approveVerifiedQuestions(clone(baseCategories), changedLedger, { verifierFiles }),
    /سجل التحقق لا يطابق/u, 'تغيير سياسة المصادر يجب أن يلغي الاعتماد.');
}
{
  const changedLedger = clone(ledger);
  const firstId = Object.keys(changedLedger.questions)[0];
  changedLedger.questions[firstId].claimSha256 = '0'.repeat(64);
  assert.throws(() => approveVerifiedQuestions(clone(baseCategories), changedLedger, { verifierFiles }),
    /سجل التحقق لا يطابق/u, 'تغيير بصمة الادعاء يجب أن يلغي الاعتماد.');
}
{
  const changedLedger = clone(ledger);
  const firstId = Object.keys(changedLedger.questions)[0];
  changedLedger.questions[firstId].evidence[0].url = 'https://www.wikidata.org/wiki/Q42';
  assert.throws(() => approveVerifiedQuestions(clone(baseCategories), changedLedger, { verifierFiles }),
    /سجل التحقق لا يطابق/u, 'تغيير دليل السؤال يجب أن يلغي الاعتماد.');
}
assert.throws(() => approveVerifiedQuestions(clone(baseCategories), clone(ledger)),
  /بلا حزمة مدققات/u, 'الاعتماد يجب أن يفشل مغلقًا من دون حزمة مدققات محددة.');

console.log('✅ بوابة الحقائق ترفض العبث بالنص والخيارات والإجابة والمصدر والمنطق وبصمات الاعتماد');
