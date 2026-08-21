import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildRuntimeQuestionPlan,
  canonicalCategory,
  difficultyTier,
  hostAllowed,
  isNearDuplicate,
  loadBaseCategories,
  loadExistingQuestionTexts,
  loadPolicy,
  loadRuntimeQuestionBank,
  stableQuestionId,
  trustedHostsForCategory,
  validateCandidate,
} from '../scripts/questions/lib.mjs';

const policy = loadPolicy();
const publishedCount = JSON.parse(fs.readFileSync(new URL('../content/questions/published.json', import.meta.url), 'utf8')).length;
const scienceHosts = trustedHostsForCategory('علوم وتقنية', policy);
assert.equal(difficultyTier(1), 'easy');
assert.equal(difficultyTier(4), 'normal');
assert.equal(difficultyTier(6), 'hard');
assert.equal(hostAllowed('https://science.nasa.gov/example', scienceHosts), true);
assert.equal(hostAllowed('https://www.fifa.com/example', scienceHosts), false, 'مصدر رياضي لا يدخل فئة العلوم.');
assert.equal(hostAllowed('http://nasa.gov/example', scienceHosts), false);
assert.equal(hostAllowed('https://nasa.gov.evil.example/test', scienceHosts), false);
assert.equal(isNearDuplicate('ما أكبر كوكب في المجموعة الشمسية؟', ['ما هو أكبر كوكب في المجموعة الشمسية؟']), true);

for (const category of loadBaseCategories()) {
  const hosts = trustedHostsForCategory(category, policy);
  assert.ok(hosts.length > 0, `${category}: تحتاج قائمة trusted hosts خاصة أو القائمة الدينية المقيدة.`);
  if (policy.religiousCategories.includes(category)) {
    assert.deepEqual(hosts, policy.religiousTrustedHosts, `${category}: لا يجوز توسيع القائمة الدينية.`);
  } else {
    assert.deepEqual(hosts, policy.categoryTrustedHosts[category], `${category}: يجب استخدام قائمة الفئة نفسها.`);
    for (const host of hosts) assert.ok(policy.generalTrustedHosts.includes(host), `${category}: ${host} خارج القائمة العامة العليا.`);
  }
}
const widenedReligiousPolicy = {
  ...policy,
  categoryTrustedHosts: { ...policy.categoryTrustedHosts, 'القرآن الكريم': ['nasa.gov'] },
};
assert.deepEqual(
  trustedHostsForCategory('القرآن الكريم', widenedReligiousPolicy),
  policy.religiousTrustedHosts,
  'الفئة الدينية تبقى محصورة حتى لو أضيف لها نطاق عام بالخطأ.',
);

const runtimePlan = buildRuntimeQuestionPlan({ targetPerLevel: policy.targetQuestionsPerLevel });
const runtimeBank = loadRuntimeQuestionBank().bank;
const effectiveQuestionTexts = loadExistingQuestionTexts();
assert.deepEqual(runtimePlan.components, { base: 192, approved: publishedCount, additions: 42 });
assert.equal(runtimePlan.componentTotal, 234 + publishedCount);
assert.equal(runtimePlan.runtimeTotal, 234 + publishedCount, 'حسبة runtime يجب أن تشمل base + approved + QUESTION_ADDITIONS.');
assert.equal(runtimePlan.runtimeCategoryCount, 38);
assert.equal(runtimePlan.totalGap, (4 * 6 * 38) - runtimePlan.runtimeTotal,
  'الفجوة هي هدف أربعة أسئلة لكل مستوى ناقص بنك runtime الحالي.');
assert.equal(runtimePlan.invalidDifficultyCount, 0);
assert.deepEqual(runtimePlan.orphanAdditionCategories, []);
assert.deepEqual(runtimePlan.categories['معلومات عامة'].levels[1], { count: 1, target: 4, gap: 3 });
assert.deepEqual(runtimePlan.categories['القرآن الكريم'].levels[1], { count: 2, target: 4, gap: 2 });
assert.deepEqual(runtimePlan.categories['ألعاب الفيديو'].levels[1], { count: 4, target: 4, gap: 0 });
assert.equal(
  runtimeBank['تاريخ'].find(question => question.d === 1)?.q,
  'أي حضارة بنت أهرامات الجيزة في مصر القديمة؟',
  'أداة التخطيط يجب أن ترى نص QUESTION_OVERRIDES نفسه الذي يراه اللاعب.',
);
assert.ok(effectiveQuestionTexts.includes('أي حضارة بنت أهرامات الجيزة في مصر القديمة؟'));
assert.ok(
  !effectiveQuestionTexts.includes('في أي حضارة بُنيت الأهرامات؟'),
  'فحص التكرار لا يجوز أن يحتسب نص السؤال المستبدل الذي لن يراه اللاعب.',
);
assert.equal(
  runtimeBank['تاريخ'].find(question => question.d === 1)?.o,
  undefined,
  'استبدال السؤال يحذف خيارات السؤال القديم كما يفعل runtime.',
);
const publishedScienceLevelTwo = runtimeBank['علوم وتقنية'].filter(
  question => question.d === 2 && question.review?.status === 'approved',
);
assert.ok(publishedScienceLevelTwo.length > 0, 'يلزم سؤال منشور لاختبار عزل التصحيحات.');
assert.ok(
  publishedScienceLevelTwo.every(question => question.q !== 'من نال براءة الاختراع الأمريكية للهاتف عام 1876؟'),
  'QUESTION_OVERRIDES لا يجوز أن يكتب فوق سؤال منشور في المستوى نفسه.',
);

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
assert.ok(validateCandidate({ ...general, source: {
  ...general.source, url: 'https://www.fifa.com/tournaments', publisher: 'FIFA',
} }, { policy, existingQuestions: [] }).errors.includes('untrusted_source'));
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
assert.match(generator, /trustedHostsForCategory/);
assert.match(generator, /buildRuntimeQuestionPlan/);
assert.match(generator, /allow-oversample/);
assert.doesNotMatch(generator, /console\.log\([^\n]*OPENAI_API_KEY/);
console.log('✓ خطة runtime تحسب base + approved + QUESTION_ADDITIONS وفجوات كل مستوى');
console.log('✓ مسار التوليد يستخدم مصادر الفئة المقيدة ومخرجات منظمة وتحققاً مستقلاً');
console.log('✓ الأسئلة الدينية لا تُنشر قبل تأكيد المراجعة البشرية للمصدر والإسناد');
