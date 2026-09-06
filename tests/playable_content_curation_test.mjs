import assert from 'node:assert/strict';
import fs from 'node:fs';

const webApp=fs.readFileSync(new URL('../www/app.js',import.meta.url),'utf8');
const webHtml=fs.readFileSync(new URL('../www/index.html',import.meta.url),'utf8');
const nativeApp=fs.readFileSync(new URL('../ios/App/App/public/app.js',import.meta.url),'utf8');
const nativeHtml=fs.readFileSync(new URL('../ios/App/App/public/index.html',import.meta.url),'utf8');

assert.equal(fs.existsSync(new URL('../www/next-question-bank.js',import.meta.url)),false,
  'يجب ألا يُشحن بنك أسئلة احتياطي مع التطبيق.');

for(const [label,source] of [['الويب',webApp],['iOS',nativeApp]]){
  assert.match(source,/const CURATED_REMOTE_CATEGORIES=new Set\(\);/,
    `${label}: الفئات يجب أن تصل من كتالوج الخادم فقط.`);
  assert.match(source,/if\(!\(await refreshRemoteQuestionCatalog\(\)\)\) throw new Error/,
    `${label}: فشل كتالوج الخادم يجب أن يمنع اختيار الفئات.`);
  assert.match(source,/if\(remoteCategories\.length!==state\.cats\.length\) return false;/,
    `${label}: كل فئات الجولة يجب أن تكون منشورة في الخادم.`);
  assert.match(source,/if\(!idToken\) return false;/,
    `${label}: لا يجوز تنزيل جولة بلا هوية خادمية.`);
  assert.match(source,/catch\(_\)\{ \/\* لا رجوع إلى بنك أو كاش محلي \*\/ \}/,
    `${label}: تعذر الخادم يجب أن يفشل بإغلاق آمن.`);
  assert.doesNotMatch(source,/remoteRoundCacheKey|remote_question_bank_required|NEXT_QUESTION_BANK/,
    `${label}: لا يجوز بقاء مسار بنك أو جولة احتياطية.`);
}

for(const [label,html] of [['الويب',webHtml],['iOS',nativeHtml]]){
  assert.doesNotMatch(html,/question-bank\.js|approved-question-bank\.js|image-question-bank(?:-commons)?\.js|next-question-bank\.js/,
    `${label}: لا يجوز تحميل أي بنك أسئلة مضمّن.`);
  assert.match(html,/image-assets\.js[\s\S]+app\.js/,
    `${label}: مدير صور أسئلة الخادم يجب أن يسبق التطبيق.`);
  assert.match(html,/id="q-options"[^>]*role="list"/,
    `${label}: واجهة السؤال يجب أن تحتوي قائمة الخيارات.`);
}

console.log('✓ الإصدار 1.4 يعتمد على كتالوج وجولات الخادم فقط، بلا بنك احتياطي محلي');
