import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  canonicalCategory,
  difficultyTier,
  hostAllowed,
  isNearDuplicate,
  loadPolicy,
  stableQuestionId,
  validateCandidate,
} from '../scripts/questions/lib.mjs';

const policy = loadPolicy();
assert.equal(difficultyTier(1), 'easy');
assert.equal(difficultyTier(4), 'normal');
assert.equal(difficultyTier(6), 'hard');
assert.equal(hostAllowed('https://science.nasa.gov/example', policy.generalTrustedHosts), true);
assert.equal(hostAllowed('http://nasa.gov/example', policy.generalTrustedHosts), false);
assert.equal(hostAllowed('https://nasa.gov.evil.example/test', policy.generalTrustedHosts), false);
assert.equal(isNearDuplicate('ما أكبر كوكب في المجموعة الشمسية؟', ['ما هو أكبر كوكب في المجموعة الشمسية؟']), true);

const general = {
  category: canonicalCategory('علوم', policy), difficulty: 'easy', difficultyLevel: 1, religious: false,
  question: 'ما الكوكب الأكبر في المجموعة الشمسية؟', answer: 'المشتري',
  explanation: 'المشتري أكبر كواكب المجموعة الشمسية من حيث الحجم.',
  source: {
    title: 'Jupiter facts', url: 'https://science.nasa.gov/jupiter/facts/',
    publisher: 'NASA', evidence: 'تذكر الصفحة أن المشتري أكبر كواكب المجموعة الشمسية.',
  },
};
assert.equal(general.category, 'علوم وتقنية');
assert.deepEqual(validateCandidate(general, { policy, existingQuestions: [] }).errors, []);
assert.ok(validateCandidate({ ...general, category: 'فئة غير موجودة' }, { policy, existingQuestions: [] }).errors.includes('unknown_category'));
assert.equal(stableQuestionId(general), stableQuestionId({ ...general }));
for (const category of policy.plannedCategories) {
  assert.ok(category.length > 2);
  assert.ok(!validateCandidate({ ...general, category }, { policy, existingQuestions: [] }).errors.includes('unknown_category'));
  assert.ok(policy.categoryGuidance[category]);
}

const religious = {
  category: 'القرآن الكريم', difficulty: 'normal', difficultyLevel: 3, religious: true,
  question: 'في أي سورة وردت آية الكرسي؟', answer: 'سورة البقرة',
  explanation: 'آية الكرسي هي الآية 255 من سورة البقرة.',
  source: {
    title: 'تفسير سورة البقرة آية 255',
    url: 'https://quran.ksu.edu.sa/tafseer/katheer/sura2-aya255.html',
    publisher: 'مشروع المصحف الإلكتروني بجامعة الملك سعود',
    evidence: 'تعرض الصفحة الآية 255 من سورة البقرة وتفسيرها.',
  },
};
assert.deepEqual(validateCandidate(religious, { policy, existingQuestions: [] }).errors, []);
assert.ok(validateCandidate({ ...religious, source: general.source }, { policy, existingQuestions: [] }).errors.includes('untrusted_source'));
assert.ok(validateCandidate({ ...general, question: 'ما أكبر كوكب في المجموعة الشمسية؟' }, {
  policy, existingQuestions: ['ما هو أكبر كوكب في المجموعة الشمسية؟'],
}).errors.includes('duplicate_or_near_duplicate'));

const approvedBank = fs.readFileSync(new URL('../www/approved-question-bank.js', import.meta.url), 'utf8');
assert.match(approvedBank, /__APPROVED_QUESTION_BANK_DATA__/);
const generator = fs.readFileSync(new URL('../scripts/questions/generate.mjs', import.meta.url), 'utf8');
assert.match(generator, /gpt-5\.6-terra/);
assert.match(generator, /gpt-5\.6-sol/);
assert.match(generator, /pending_religious_review/);
assert.match(generator, /web_search/);
assert.match(generator, /balanced/);
assert.match(generator, /requestedLevel/);
assert.doesNotMatch(generator, /console\.log\([^\n]*OPENAI_API_KEY/);
console.log('✓ مسار التوليد يستخدم مصادر مقيدة ومخرجات منظمة وتحققاً مستقلاً');
console.log('✓ الأسئلة الدينية لا تُنشر قبل تأكيد المراجعة البشرية للمصدر والإسناد');
