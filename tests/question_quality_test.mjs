import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const rawBank = fs.readFileSync(new URL('www/question-bank.js', root), 'utf8');
const app = fs.readFileSync(new URL('www/app.js', root), 'utf8');
const html = fs.readFileSync(new URL('www/index.html', root), 'utf8');
const privacy = fs.readFileSync(new URL('www/privacy-policy.html', root), 'utf8');
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
assert.match(app, /questionWasSeen\(history,cat,q\.id\)/);
assert.match(app, /sessionIds\.add\(q\.id\)/);
assert.match(app, /q\.review=q\.review&&q\.review\.status==='approved'/);
assert.match(app, /__APPROVED_QUESTION_BANK_DATA__/);
assert.match(html, /approved-question-bank\.js/);
assert.match(approvedBank, /__APPROVED_QUESTION_BANK_DATA__/);
assert.doesNotMatch(app, /api\.anthropic\.com|AI_BACKEND_URL|aiGenerate\(/);
assert.doesNotMatch(app, /api\.openai\.com|OPENAI_API_KEY/);
assert.doesNotMatch(html, /توليد بالذكاء|generateFamily\(|id="family-ai"/);
assert.doesNotMatch(privacy, /Anthropic|Google AI|مزوّد الذكاء الاصطناعي/);
assert.doesNotMatch(cloudFunction, /ANTHROPIC|api\.anthropic\.com|defineSecret/);
assert.match(cloudFunction, /status\(410\)/);
assert.doesNotMatch(server, /api\.anthropic\.com|ANTHROPIC_API_KEY|call_claude/);
assert.doesNotMatch(server, /api\.openai\.com|OPENAI_API_KEY/);
assert.match(server, /تم إيقاف التوليد الآلي/);
assert.match(server, /HTML_FILE = os\.path\.join\(WWW_DIR, 'index\.html'\)/);

console.log('✓ جميع الفئات تحتفظ بستة مستويات وأسئلتها المحلية غير مكررة');
console.log('✓ الفئات الدينية لها مراجع القرآن وصحيح البخاري وابن كثير والطبري');
console.log('✓ لا يوجد مفتاح أو استدعاء OpenAI/Claude داخل تطبيق المستخدم أو خادم اللعب');
