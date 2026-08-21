import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = `file://${path.join(root, 'www/index.html')}`;
const browser = await chromium.launch();

try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route('**/*', route => {
    if (route.request().url().startsWith('file://')) return route.continue();
    return route.abort();
  });
  await page.goto(url);

  const audit = await page.evaluate(async () => {
    await ensureQuestionBank();
    const samples = [
      ['وش اسم عاصمة الكويت؟', 'شنو اسم عاصمة الكويت؟'],
      ['مين أول لاعب سجّل؟', 'منو أول لاعب سجّل؟'],
      ['ما هو أكبر كوكب؟', 'شنو أكبر كوكب؟'],
      ['من هي مؤلفة الكتاب؟', 'منو مؤلفة الكتاب؟'],
      ['أين تقع الكويت؟', 'وين تقع الكويت؟'],
      ['كيف ينقاس النجاح؟', 'شلون ينقاس النجاح؟'],
      ['لماذا اختير هذا الاسم؟', 'ليش اختير هذا الاسم؟'],
      ['تقريباً كم سنة؟', 'تقريباً جم سنة؟'],
    ].map(([source, expected]) => ({ source, expected, actual: toKuwaitiQuestionText(source) }));
    const questions = Object.values(QUESTION_BANK).flat();
    const visibleQuestions = questions.map(question => displayQuestionText(question));
    const nonKuwaitiQuestion = /(^|\s)(وش|مين|إيش|أيش|ايش|أين|كيف|لماذا|كم)(?=\s|[؟?!،,.])/u;
    const uiText = [
      ...document.querySelectorAll('section:not(#s-privacy):not(#s-terms), .q-wrap, .modal-wrap, .offline-bar'),
    ].map(element => element.textContent || '').join(' ');
    const nonKuwaitiUi = /(وش|مين|أهلاً|كم فريق|كم عدد|اختر|جاري|لا أحد|استئناف|توقّف مؤقّت)/u;
    const original = questions.find(question => /^(وش|مين)\s/u.test(question.q));

    return {
      lang: document.documentElement.lang,
      samples,
      invalidQuestions: visibleQuestions.filter(text => nonKuwaitiQuestion.test(text)),
      invalidUi: uiText.match(nonKuwaitiUi)?.[0] || '',
      category: displayCategoryName('وش الرابط؟'),
      userQuestion: displayQuestionText({ q: 'وش اسم جدّي؟' }),
      originalQuestionStillStored: original?.q || '',
      displayedOriginal: original ? displayQuestionText(original) : '',
      legalPrivacy: document.querySelector('#s-privacy')?.textContent || '',
      legalTerms: document.querySelector('#s-terms')?.textContent || '',
    };
  });

  assert.equal(audit.lang, 'ar-KW', 'هوية المستند يجب أن تعلن العربية الكويتية.');
  for (const sample of audit.samples) {
    assert.equal(sample.actual, sample.expected, `تحويل كويتي غير صحيح: ${sample.source}`);
  }
  assert.deepEqual(audit.invalidQuestions, [], 'كل أسئلة بنك فطنة يجب أن تظهر باللهجة الكويتية.');
  assert.equal(audit.invalidUi, '', `بقي لفظ غير كويتي في الواجهة: ${audit.invalidUi}`);
  assert.equal(audit.category, 'شنو الرابط؟');
  assert.equal(audit.userQuestion, 'وش اسم جدّي؟', 'لا تغيّر النص الذي كتبه المستخدم بنفسه.');
  assert.match(audit.originalQuestionStillStored, /^(وش|مين)\s/u, 'نص البنك المراجع يبقى محفوظاً كما نُشر.');
  assert.doesNotMatch(audit.displayedOriginal, /^(وش|مين)\s/u, 'طبقة العرض وحدها تحوّل نص البنك.');
  assert.match(audit.legalPrivacy, /تطبيق فطنة يحترم خصوصيتك/u, 'سياسة الخصوصية تبقى عربية رسمية.');
  assert.match(audit.legalTerms, /التطبيق مقدَّم "كما هو" بدون ضمانات/u, 'شروط الاستخدام تبقى عربية رسمية.');

  console.log('✓ الواجهة والأسئلة عربية كويتية، مع حفظ نص البنك والمحتوى القانوني الرسمي');
} finally {
  await browser.close();
}
