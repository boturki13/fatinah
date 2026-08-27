import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const rawBank = fs.readFileSync(new URL('www/question-bank.js', root), 'utf8');
const app = fs.readFileSync(new URL('www/app.js', root), 'utf8');
const html = fs.readFileSync(new URL('www/index.html', root), 'utf8');
const privacy = fs.readFileSync(new URL('www/privacy-policy.html', root), 'utf8');
const appTerms = fs.readFileSync(new URL('www/terms-of-service.html', root), 'utf8');
const publicTerms = fs.readFileSync(new URL('legal/terms.html', root), 'utf8');
const approvedBank = fs.readFileSync(new URL('www/approved-question-bank.js', root), 'utf8');
const cloudFunction = fs.readFileSync(new URL('functions/index.js', root), 'utf8');
const server = fs.readFileSync(new URL('server.py', root), 'utf8');

const sandbox = { window: {} };
vm.runInNewContext(rawBank, sandbox);
const bank = sandbox.window.__QUESTION_BANK_DATA__;
assert.ok(bank && typeof bank === 'object');
assert.ok(Object.keys(bank).length >= 32, 'يجب ألا تختفي أي فئة عند تحديث البنك.');

for (const [category, questions] of Object.entries(bank)) {
  assert.ok(questions.length >= 6, `${category}: تحتاج ستة أسئلة على الأقل.`);
  assert.equal(new Set(questions.map(q => q.q.trim())).size, questions.length, `${category}: يوجد نص سؤال مكرر.`);
  for (let difficulty = 1; difficulty <= 6; difficulty++) {
    assert.ok(questions.some(q => q.d === difficulty), `${category}: المستوى ${difficulty} مفقود.`);
  }
  assert.match(app, new RegExp(`['"]${category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*:`), `${category}: مصدر الفئة مفقود.`);
}

for (const category of ['دين وسيرة','السيرة النبوية','القرآن الكريم','فتوحات المسلمين','الصحابة','الخلفاء الراشدون','الأنبياء والرسل']) {
  assert.match(app, new RegExp(`QUESTION_OVERRIDES[\\s\\S]*?['"]${category}['"]\\s*:`), `${category}: يحتاج مراجعة دينية صريحة.`);
  const additionStart = app.indexOf(`  '${category}':[`, app.indexOf('const QUESTION_ADDITIONS='));
  assert.ok(additionStart >= 0, `${category}: دفعة التوسعة المراجعة مفقودة.`);
  const additionEnd = app.indexOf('\n  ],', additionStart);
  const additionBlock = app.slice(additionStart, additionEnd);
  assert.equal((additionBlock.match(/\{d:[1-6],q:/g) || []).length, 6, `${category}: يجب إضافة سؤال واحد لكل مستوى.`);
}

assert.match(app, /questionHistoryOwner\(\)/);
assert.match(app, /questionWasSeen\(history,cat,q\)/);
assert.match(app, /sessionIds\.add\(q\.id\)/);
assert.doesNotMatch(app, /\{status:'approved',bankVersion:2,reviewedAt:'2026-08-20'\}/);
assert.match(app, /pending_religious_review/);
assert.match(app, /hasExplicitApproval/);
assert.match(app, /religiousSourceAndIsnadConfirmed===true/);
assert.match(app, /__APPROVED_QUESTION_BANK_DATA__/);
assert.match(html, /approved-question-bank\.js/);
assert.match(approvedBank, /__APPROVED_QUESTION_BANK_DATA__/);
assert.doesNotMatch(app, /api\.anthropic\.com|AI_BACKEND_URL|aiGenerate\(/);
assert.doesNotMatch(app, /api\.openai\.com|OPENAI_API_KEY/);
assert.doesNotMatch(
  app,
  /q:\s*['"]كم عدد[^'"]*:\s*[^'"]+['"]/u,
  'سؤال العدّ لا يجوز أن يسرد العناصر المطلوب عدّها داخل نص السؤال.',
);
assert.match(app, /q:'كم عدد أيام التشريق\؟',answer:'ثلاثة أيام'/);
const serverBank = JSON.parse(fs.readFileSync(new URL('server-assets/question-bank/v1/bank.json', root), 'utf8'));
const runtimeQuestions = Object.values(serverBank.categories).flat();
assert.ok(!runtimeQuestions.some(item => /(?:UNESCO|اليونسكو).*?(?:المكوّن|المكون|المعرّف|المعرف)\s*\d/iu.test(item.q)),
  'لا يجوز عرض معرّفات اليونسكو الداخلية للاعب كسؤال معلومات عامة.');
for (const leakedAnswerQuestion of [
  'المعروف في السعودية ودول الخليج باسم الكبسة أو المكبوس',
  'الأنمي (الرسوم المتحركة اليابانية)',
  'يحمل عنوان رواية «صورة دوريان غراي» اسمها',
  'يحمل عنوان رواية «فرانكنشتاين» اسمه',
]) {
  assert.doesNotMatch(`${app}\n${approvedBank}`,new RegExp(leakedAnswerQuestion.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),'لا يجوز أن يكشف نص السؤال الإجابة.');
}
assert.match(app, /ما اسم طبق خليجي يُطهى من الأرز المتبّل مع اللحم أو الدجاج\؟/);
assert.match(app, /في أي دولة ظهر فن الأنمي بصورته الحديثة\؟/);
assert.match(approvedBank, /من الشخصية التي يرتبط مصيرها بصورة مرسومة/);
assert.match(approvedBank, /من العالم الشاب الذي صنع مخلوقاً حياً/);
assert.doesNotMatch(html, /توليد بالذكاء|generateFamily\(|id="family-ai"/);
assert.doesNotMatch(privacy, /Anthropic|Google AI|مزوّد الذكاء الاصطناعي/);
assert.doesNotMatch(`${appTerms}\n${publicTerms}`, /\$3\.99|\$29\.99|قوانين المملكة العربية السعودية/);
assert.match(appTerms, /بعملتك المحلية/);
assert.match(publicTerms, /قوانين دولة الكويت/);
// عقد v1 يبقى متوافقاً مؤقتاً مع النسخة 1.2 المنشورة. الحظر المطلوب هو أن
// تطبيق 1.3 وعقد v2 لا يستدعيا أي مزوّد توليد وقت التشغيل.
assert.match(cloudFunction, /exports\.generateQuestions\s*=\s*onRequest/);
const cloudFunctionV2Handler = cloudFunction
  .split('async function generateQuestionsV2Handler', 2)[1]
  ?.split('exports.generateQuestionsV2 = onRequest', 1)[0] || '';
const cloudFunctionV2Export = cloudFunction.split('exports.generateQuestionsV2 = onRequest', 2)[1] || '';
assert.ok(cloudFunctionV2Handler && cloudFunctionV2Export, 'عقد Cloud Function v2 مفقود.');
assert.doesNotMatch(cloudFunctionV2Handler, /ANTHROPIC|api\.anthropic\.com|defineSecret/);
assert.match(cloudFunctionV2Handler, /status\(410\)/);
assert.match(cloudFunctionV2Export, /generateQuestionsV2Handler/);
assert.doesNotMatch(server, /api\.anthropic\.com|ANTHROPIC_API_KEY|call_claude/);
assert.doesNotMatch(server, /api\.openai\.com|OPENAI_API_KEY/);
assert.match(server, /if self\._api_version == '2'/);
assert.match(server, /ai_generation_retired/);
assert.match(server, /HTML_FILE = os\.path\.join\(WWW_DIR, 'index\.html'\)/);

console.log('✓ جميع الفئات تحتفظ بستة مستويات وأسئلتها المحلية غير مكررة');
console.log('✓ الفئات الدينية مقيّدة بمراجعة صريحة، واعتماد التشغيل موثق ببصمة لكل سؤال وإسناده');
console.log('✓ لا يوجد مفتاح أو استدعاء OpenAI/Claude داخل تطبيق المستخدم أو خادم اللعب');
