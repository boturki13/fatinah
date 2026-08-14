/**
 * فحوصات ثابتة لإعدادات خصوصية iOS التي يفحصها App Store Connect.
 *
 * تشغيل: node tests/ios_privacy_config_test.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const infoPlist = await readFile(path.join(root, 'ios/App/App/Info.plist'), 'utf8');
const privacyManifest = await readFile(path.join(root, 'ios/App/App/PrivacyInfo.xcprivacy'), 'utf8');
const project = await readFile(path.join(root, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8');
const entitlements = await readFile(path.join(root, 'ios/App/App/App.entitlements'), 'utf8');
const webApp = await readFile(path.join(root, 'www/index.html'), 'utf8');
const webLogic = await readFile(path.join(root, 'www/app.js'), 'utf8');
const webStyles = await readFile(path.join(root, 'www/app.css'), 'utf8');
const questionBank = await readFile(path.join(root, 'www/question-bank.js'), 'utf8');
const nativeWebApp = await readFile(path.join(root, 'ios/App/App/public/index.html'), 'utf8');
const nativeWebLogic = await readFile(path.join(root, 'ios/App/App/public/app.js'), 'utf8');
const nativeWebStyles = await readFile(path.join(root, 'ios/App/App/public/app.css'), 'utf8');
const nativeQuestionBank = await readFile(path.join(root, 'ios/App/App/public/question-bank.js'), 'utf8');
const cloudFunction = await readFile(path.join(root, 'functions/index.js'), 'utf8');
const capacitorConfig = await readFile(path.join(root, 'capacitor.config.ts'), 'utf8');

assert.doesNotMatch(
  infoPlist,
  /NSUserTrackingUsageDescription/,
  'لا تضف طلب تتبع ما لم يكن التطبيق يتتبع المستخدمين فعلاً وتُحدَّث إفصاحات App Store Connect.'
);

assert.match(privacyManifest, /<key>NSPrivacyTracking<\/key>\s*<false\/>/);

for (const dataType of [
  'NSPrivacyCollectedDataTypeUserID',
  'NSPrivacyCollectedDataTypeName',
  'NSPrivacyCollectedDataTypeEmailAddress',
  'NSPrivacyCollectedDataTypePurchaseHistory',
  'NSPrivacyCollectedDataTypeOtherUserContent',
]) {
  assert.match(privacyManifest, new RegExp(`<string>${dataType}<\\/string>`));
}

assert.match(project, /PrivacyInfo\.xcprivacy in Resources/);
assert.doesNotMatch(
  entitlements,
  /com\.apple\.developer\.game-center/,
  'Game Center غير مستخدم في التطبيق؛ لا تحتفظ بالـ entitlement دون ميزة فعلية.'
);

assert.match(
  webLogic,
  /const remainingUser = await FA\.getCurrentUser\(\)\.catch\(\(\)=>null\);[\s\S]*?Firebase user still exists after deleteUser/,
  'لا تعلن نجاح حذف الحساب قبل التأكد من اختفاء مستخدم Firebase.'
);
assert.match(
  webLogic,
  /const current = await FA\.getCurrentUser\(\)\.catch\(\(\)=>null\);[\s\S]*?if\(!current \|\| !current\.user\) return '';/,
  'لا تطلب رمز Firebase بعد تسجيل الخروج أو حذف الحساب.'
);
assert.ok(
  webLogic.includes("const mustRestoreAnonymousSession = storedProvider === 'anonymous';") &&
    webLogic.includes("storedProvider !== 'local' && !mustRestoreAnonymousSession"),
  'يجب ترحيل المعرف المحلي القديم إلى جلسة Firebase مجهولة عند توفرها.'
);
assert.match(
  webLogic,
  /go\('s-paywall'\);\s*void \(async \(\)=>\{[\s\S]*?checkSubscriptionAndRoute\(uid, \{showLoading:false\}\);/,
  'يجب إظهار واجهة الاشتراك فوراً والتحقق من الصلاحية في الخلفية.'
);
assert.match(
  webLogic,
  /async function checkSubscriptionAndRoute\(uid, \{showLoading=true\} = \{\}\)\{\s*if\(showLoading\) go\('s-loading'\);/,
  'يجب أن يدعم فحص الاشتراك وضع الخلفية عند الإقلاع.'
);
assert.doesNotMatch(webLogic, /const QUESTION_BANK = \{/);
assert.match(webLogic, /function ensureQuestionBank\(\)[\s\S]*?script\.src='question-bank\.js';/);
assert.match(webLogic, /const TEAM_STYLES=\[/);
assert.match(webLogic, /const FIRE=\[null,/);
assert.match(webLogic, /const POINTS=\[0,100,200,300,400,500,600\]/);
assert.match(webLogic, /const API_ORIGIN = window\.Capacitor\?\.isNativePlatform\?\.\(\) === true/);
assert.match(webLogic, /function apiUrl\(path\)\{ return `\$\{API_ORIGIN\}\$\{path\}`; \}/);
assert.match(capacitorConfig, /launchShowDuration:\s*700/);
assert.match(questionBank, /^window\.__QUESTION_BANK_DATA__ = \{/);
assert.ok(
  Buffer.byteLength(questionBank) > 20_000 && Buffer.byteLength(questionBank) < 100_000,
  'يجب أن يكون بنك الطوارئ المحلي صغيراً، مع بقاء التوليد الموثق للخادم.'
);
assert.equal(nativeWebApp, webApp, 'يجب مزامنة www مع نسخة iOS قبل البناء.');
assert.equal(nativeWebLogic, webLogic, 'يجب مزامنة JavaScript مع نسخة iOS قبل البناء.');
assert.equal(nativeWebStyles, webStyles, 'يجب مزامنة CSS مع نسخة iOS قبل البناء.');
assert.equal(nativeQuestionBank, questionBank, 'يجب مزامنة بنك الأسئلة مع نسخة iOS قبل البناء.');
assert.match(webLogic, /prepareTrustedRoundQuestions\(state\.cats,token\)/);
assert.match(webLogic, /AI_ROUND_BLOCKED_CATEGORIES/);
assert.match(webApp, /id="q-source"/);
assert.match(cloudFunction, /const TRUSTED_SOURCE_HOSTS/);
assert.match(cloudFunction, /async function reachableTrustedSource/);
assert.match(cloudFunction, /trustedRound/);

console.log('✓ لا يوجد طلب تتبع في iOS أو في Privacy Manifest');
console.log('✓ إفصاحات الخصوصية المعلنة في المشروع موجودة');
console.log('✓ Privacy Manifest مضمن في target وGame Center غير مفعّل');
console.log('✓ حذف الحساب لا يعلن نجاحاً قبل التحقق من Firebase');
console.log('✓ الهويات المحلية القديمة تُرقّى إلى Firebase عند توفرها');
console.log('✓ واجهة الإقلاع لا تنتظر الشبكة قبل الظهور');
console.log('✓ بنك الطوارئ مؤجل التحميل وصغير، والتوليد الموثق يبقى خارج التطبيق');
console.log('✓ الأسئلة المولّدة لا تمر إلا بمراجع HTTPS موثوقة ورابط متاح');
