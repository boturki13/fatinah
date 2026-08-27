import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildRuntimeQuestionPlan,
  canonicalCategory,
  difficultyTier,
  excludeAmbiguousStructuredRecords,
  hostAllowed,
  isNearDuplicate,
  loadBaseCategories,
  loadExistingQuestionTexts,
  loadImageQuestionBank,
  loadReleaseImageQuestionBank,
  loadPolicy,
  loadRuntimeQuestionBank,
  stableQuestionId,
  trustedHostsForCategory,
  validateCandidate,
  verificationSchema,
} from '../scripts/questions/lib.mjs';
import { buildExactBankPlan } from '../scripts/questions/plan-bank.mjs';
import { buildGenerationQueue } from '../scripts/questions/build-generation-queue.mjs';

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
assert.equal(isNearDuplicate('هالعلم 🇰🇼 يرجع لأي دولة؟', ['هالعلم 🇯🇵 يرجع لأي دولة؟']), false,
  'أعلام الدول المختلفة لا تُعامل كأسئلة مكررة بعد التطبيع.');
const ambiguousSourceRecords = [
  { category: 'اختبار', itemId: 'Q1', property: 'P57', answerId: 'Q2' },
  { category: 'اختبار', itemId: 'Q1', property: 'P57', answerId: 'Q3' },
  { category: 'اختبار', itemId: 'Q4', property: 'P57', answerId: 'Q5' },
];
assert.deepEqual(excludeAmbiguousStructuredRecords(ambiguousSourceRecords), [ambiguousSourceRecords[2]],
  'أي علاقة منظمة لها أكثر من جواب تُحجب بالكامل قبل توليد السؤال.');

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
const summedRuntimeGap = Object.values(runtimePlan.categories).reduce((categorySum, category) =>
  categorySum + Object.values(category.levels).reduce((levelSum, level) => levelSum + level.gap, 0), 0);
assert.equal(runtimePlan.totalGap, summedRuntimeGap,
  'الفجوة تجمع النقص الفعلي لكل مستوى ولا تخفيه زيادة مستوى آخر فوق هدفه.');
assert.equal(runtimePlan.invalidDifficultyCount, 0);
assert.deepEqual(runtimePlan.orphanAdditionCategories, []);
const generalLevelOneCount = runtimeBank['معلومات عامة'].filter(question => question.d === 1).length;
assert.deepEqual(runtimePlan.categories['معلومات عامة'].levels[1], {
  count: generalLevelOneCount, target: 4, gap: Math.max(0, 4 - generalLevelOneCount),
});
assert.deepEqual(runtimePlan.categories['القرآن الكريم'].levels[1], { count: 2, target: 4, gap: 2 });
const videoLevelOneCount = runtimeBank['ألعاب الفيديو'].filter(question => question.d === 1).length;
assert.deepEqual(runtimePlan.categories['ألعاب الفيديو'].levels[1], {
  count: videoLevelOneCount, target: 4, gap: Math.max(0, 4 - videoLevelOneCount),
});
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
assert.ok(validateCandidate({ ...general, question: 'أي كوكب يُعرف باسم المشتري؟' }, {
  policy, existingQuestions: [],
}).errors.includes('answer_leaked_in_question'));
assert.ok(validateCandidate({ ...general, explanation: 'اختبر معلوماتك العامة.' }, {
  policy, existingQuestions: [],
}).errors.includes('generic_explanation'));
assert.ok(validateCandidate({ ...general, source: {
  ...general.source, url: 'https://www.loc.gov/example/source.pdf', publisher: 'Library of Congress',
} }, { policy, existingQuestions: [] }).errors.includes('direct_file_source'));
assert.ok(validateCandidate({ ...general, source: {
  ...general.source, url: 'https://www.nasa.gov/example/answer.png', publisher: 'NASA',
} }, { policy, existingQuestions: [] }).errors.includes('direct_file_source'));
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
  sourcePacketId: 'quran-2-255-reviewed',
  question: 'في أي سورة وردت آية الكرسي؟', answer: 'سورة البقرة',
  explanation: 'آية الكرسي هي الآية 255 من سورة البقرة.',
  source: {
    title: 'تفسير سورة البقرة آية 255',
    url: 'https://quran.ksu.edu.sa/tafseer/katheer/sura2-aya255.html',
    publisher: 'مشروع المصحف الإلكتروني بجامعة الملك سعود',
    evidence: 'تعرض الصفحة الآية 255 من سورة البقرة وتفسيرها.',
  },
};
const religiousSourcePackets = [{
  id: 'quran-2-255-reviewed', work: 'القرآن الكريم', reference: 'سورة البقرة، الآية 255',
  arabicText: 'اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ الْحَيُّ الْقَيُّومُ',
  source: {
    title: 'تفسير سورة البقرة آية 255',
    url: 'https://quran.ksu.edu.sa/tafseer/katheer/sura2-aya255.html',
    publisher: 'مشروع المصحف الإلكتروني بجامعة الملك سعود',
  },
  humanReview: { approved: true, reviewer: 'مراجع بشري', reviewedAt: '2026-08-24T00:00:00.000Z' },
}];
assert.deepEqual(validateCandidate(religious, { policy, existingQuestions: [], religiousSourcePackets }).errors, []);
assert.ok(validateCandidate({ ...religious, source: general.source }, { policy, existingQuestions: [] }).errors.includes('untrusted_source'));
assert.ok(validateCandidate({ ...religious, sourcePacketId: '' }, {
  policy, existingQuestions: [], religiousSourcePackets,
}).errors.includes('religious_source_packet_missing'));
assert.deepEqual(policy.religiousRules.allowedPrimaryWorks, ['القرآن الكريم', 'صحيح البخاري']);
assert.deepEqual(policy.religiousRules.allowedSecondaryWorksWithHumanReview, []);
assert.equal(policy.legacyReviewedDirectFileSources.length, 9);
assert.equal(new Set(policy.legacyReviewedDirectFileSources.map(item => `${item.id}|${item.url}`)).size, 9);

const bankPlan = buildExactBankPlan({ targetBankSize: 5000, policy });
const imageQuestionCount = Object.values(loadReleaseImageQuestionBank()).flat().length;
const candidates = JSON.parse(fs.readFileSync(
  new URL('../content/questions/candidates.json', import.meta.url), 'utf8'));
const publishedIds = new Set(JSON.parse(fs.readFileSync(
  new URL('../content/questions/published.json', import.meta.url), 'utf8')).map(item => item.id));
const stagedApprovedCount = candidates.filter(
  item => item.status === 'approved' && !publishedIds.has(item.id)).length;
assert.equal(bankPlan.targetBankSize, 5000);
assert.deepEqual(bankPlan.components, {
  runtimeText: runtimePlan.runtimeTotal,
  runtimeImages: imageQuestionCount,
  stagedApproved: stagedApprovedCount,
});
assert.equal(bankPlan.currentTotal, runtimePlan.runtimeTotal + imageQuestionCount + stagedApprovedCount);
assert.equal(Object.values(bankPlan.visibleTargets).reduce((sum, count) => sum + count, 0), 5000);
assert.equal(Object.values(bankPlan.categories).reduce((sum, category) => sum + category.target, 0), 5000);
assert.ok(bankPlan.visibleTargets['إسلاميات'] > 0);
assert.equal(bankPlan.visibleCategoryCount, 39);
assert.equal(Object.values(bankPlan.categories).filter(category => category.kind === 'image').length, 7);
assert.equal(bankPlan.categories['منو هاللاعب؟'], undefined);
for (const category of Object.values(bankPlan.categories)) {
  for (const level of Object.values(category.levels)) assert.ok(level.target >= level.current);
}
const generationQueue = buildGenerationQueue(bankPlan, policy);
assert.equal(generationQueue.questionsToGenerate, bankPlan.gapTotal);
assert.equal(generationQueue.currentQuestionCount + generationQueue.questionsToGenerate, 5000);
assert.ok(generationQueue.jobs.every(job => job.count >= 1 && job.count <= 25));
assert.equal(policy.generationStrategy.defaultMode, 'deterministic_structured_source');
assert.equal(policy.generationStrategy.paidAiGenerationEnabled, false);
assert.equal(generationQueue.paidAiGenerationEnabled, false);
assert.ok(generationQueue.jobs.filter(job => job.sourceMode === 'structured_dataset_template')
  .every(job => job.generationModel === 'deterministic-structured-template-v1' &&
    job.verificationModel === 'schema-source-and-duplicate-v1' &&
    job.status === 'blocked_until_structured_source_records'));
assert.equal(generationQueue.jobs.some(job => /gpt|openai/i.test(
  `${job.generationModel} ${job.verificationModel}`)), false,
  'طابور بنك 5000 لا يحتوي أي نموذج AI مدفوع.');
assert.ok(generationQueue.jobs.filter(job => job.sourceMode === 'double_verified_deterministic_packet')
  .every(job => job.generationModel === 'deterministic-religious-template-v1' &&
    job.verificationModel === 'canonical-source-double-verification-v1' &&
    job.status === 'blocked_until_double_verified_source_packets'));
assert.ok(generationQueue.jobs.filter(job => job.sourceMode === 'curated_image_with_rights')
  .every(job => job.generationModel === 'deterministic-curated-image-v1' &&
    job.verificationModel === 'image-rights-and-asset-v1' &&
    job.status === 'blocked_until_curated_image_assets'));
assert.ok(validateCandidate({ ...general, question: 'ما أكبر كوكب في المجموعة الشمسية؟' }, {
  policy, existingQuestions: ['ما هو أكبر كوكب في المجموعة الشمسية؟'],
}).errors.includes('duplicate_or_near_duplicate'));

const approvedBank = fs.readFileSync(new URL('../www/approved-question-bank.js', import.meta.url), 'utf8');
assert.match(approvedBank, /__APPROVED_QUESTION_BANK_DATA__/);
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.match(packageJson.scripts['questions:plan-bank'], /--write/);
assert.match(packageJson.scripts['questions:build-generation-queue'], /--write/);
const generator = fs.readFileSync(new URL('../scripts/questions/generate.mjs', import.meta.url), 'utf8');
assert.match(generator, /gpt-5\.6-terra/);
assert.match(generator, /gpt-5\.6-sol/);
assert.match(generator, /pending_religious_review/);
assert.match(generator, /web_search/);
assert.match(generator, /balanced/);
assert.match(generator, /requestedLevel/);
assert.match(generator, /trustedHostsForCategory/);
assert.match(generator, /loadReligiousSourcePackets/);
assert.match(generator, /ممنوع البحث المفتوح/);
assert.match(generator, /توليد AI الحر للأسئلة الدينية متوقف دائماً/);
assert.match(generator, /answerNotRevealed/);
assert.ok(verificationSchema.properties.results.items.required.includes('answerNotRevealed'));
assert.match(generator, /buildRuntimeQuestionPlan/);
assert.match(generator, /allow-oversample/);
assert.doesNotMatch(generator, /console\.log\([^\n]*OPENAI_API_KEY/);
console.log('✓ خطة runtime تحسب base + approved + QUESTION_ADDITIONS وفجوات كل مستوى');
console.log('✓ مسار التوليد يستخدم مصادر الفئة المقيدة ومخرجات منظمة وتحققاً مستقلاً');
console.log('✓ الأسئلة الدينية تستخدم قوالب حتمية مزدوجة التحقق بلا توليد AI حر');
