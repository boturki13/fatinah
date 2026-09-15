import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const read = path => fs.readFileSync(new URL(path, root), 'utf8');
const exists = path => fs.existsSync(new URL(path, root));

// لا يعود أي بنك قديم أو مولّد إلى 1.4. النظام الجديد يبدأ بقاعدة نظيفة.
const removedPaths = [
  'content/questions',
  'content/image-questions',
  'server-assets/question-bank',
  'server-assets/question-images',
  'scripts/questions',
  'scripts/images',
  'functions',
  'www/question-bank.js',
  'www/approved-question-bank.js',
  'www/image-assets.js',
  'www/image-question-bank.js',
  'www/image-question-bank-commons.js',
];
for (const path of removedPaths) {
  assert.equal(exists(path), false, `${path} must stay removed`);
}

const html = read('www/index.html');
assert.doesNotMatch(html, /id="s-cats"|id="s-board"|set-category-count|اختيار الفئات|اختار فئات/);
assert.doesNotMatch(html, /سرقة/);
assert.match(html, /id="seg-players"[\s\S]*?data-n="1"[\s\S]*?data-n="2"[\s\S]*?data-n="3"/);
assert.match(html, /id="modern-question-count"[^>]+min="10"[^>]+max="30"/);
for (const lifeline of ['phone', 'eliminate', 'change', 'double']) {
  assert.match(html, new RegExp(`data-lifeline="${lifeline}"`));
}

const app = read('www/app.js');
const game = read('www/game-v2.js');
assert.doesNotMatch(app, /\/api\/questions\//,
  'the client must not call removed question endpoints');
assert.doesNotMatch(app, /QUESTION_OVERRIDES|QUESTION_ADDITIONS|CAT_VISUALS|CAT_GROUPS/,
  'embedded question and category content must stay removed');
assert.doesNotMatch(app, /QUESTION_BANK|ALL_CATS|roundQuestionBank|renderCats|s-cats|s-board|startBomb|stealQueue/,
  'dead category and legacy game logic must not remain in the app bundle');
assert.match(game, /\/api\/v2\/game\/\$\{path\}/);
assert.match(game, /packs\/readiness[\s\S]*?savePendingPackClaim[\s\S]*?claimFreeRound/,
  'الجولة المجانية يجب ألا تُستهلك قبل جاهزية البنك وحفظ حالة الاستكمال.');
assert.match(game, /const hasNext=nextPosition<modernGame\.answerOrder\.length[\s\S]*?if\(hasNext\)[\s\S]*?else revealModernAnswer/,
  'الحل يجب ألا يظهر قبل إجابة آخر لاعب.');
const answerSubmission = game.match(/function submitModernAnswer[\s\S]*?\n}\nfunction revealModernAnswer/)?.[0] || '';
assert.doesNotMatch(answerSubmission, /modernGame\.eliminated=new Set\(\)/,
  'حذف إجابتين يجب أن يبقى سارياً حتى يجيب جميع اللاعبين.');
assert.match(game, /modernGame\.players\[owner\]\.score\+=question\.points\*2/);
assert.match(game, /modernGame\.players\[owner\]\.score-=penalty/);
assert.match(game, /wrong\.slice\(0,2\)/);
assert.match(game, /replacements\?\.\[`\$\{owner\}:\$\{modernGame\.current\.level\}`\]/);

const secureNative = read('ios/App/App/RevenueCatKeyStorePlugin.swift');
assert.match(secureNative, /final class FatinahSecureGamePackPlugin/);
assert.match(secureNative, /AES\.GCM\.seal/);
assert.match(secureNative, /AES\.GCM\.open/);
assert.match(secureNative, /kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/);
assert.match(game, /provider:'ios-keychain-aesgcm'/);
assert.match(game, /provider:'webcrypto-aesgcm'/);

const packageJson = JSON.parse(read('package.json'));
for (const name of Object.keys(packageJson.scripts)) {
  assert.doesNotMatch(name, /^(?:questions|images):/,
    `removed content command remains: ${name}`);
}

const server = read('server.py');
assert.match(server, /REMOVED_CONTENT_ROUTES = frozenset/);
assert.match(server, /'code': 'question_content_removed'/);
for (const route of ['packs/ensure', 'packs/start', 'packs/complete', 'questions/report']) {
  assert.match(server, new RegExp(`/api/game/${route}`));
}
const platform = read('question_platform.py');
assert.match(platform, /BLOCKED_PUBLIC_CONTENT/);
assert.match(platform, /safety_reviewed/);
assert.match(platform, /minimumPerLevel.*100/s);
assert.ok(exists('admin/index.html') && exists('admin/app.js') && exists('admin/app.css'));

console.log('✓ أزيل النظام القديم، وثُبّت عقد الجولات الجديد بلا فئات');
