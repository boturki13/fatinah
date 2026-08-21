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
const podfile = await readFile(path.join(root, 'ios/App/Podfile'), 'utf8');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const metricKitService = await readFile(path.join(root, 'ios/App/App/FatinahMetricKitService.swift'), 'utf8');
const scheme = await readFile(path.join(root, 'ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme'), 'utf8');

assert.doesNotMatch(
  infoPlist,
  /NSUserTrackingUsageDescription/,
  'لا تضف طلب تتبع ما لم يكن التطبيق يتتبع المستخدمين فعلاً وتُحدَّث إفصاحات App Store Connect.'
);
assert.match(entitlements, /com\.apple\.developer\.devicecheck\.appattest-environment/);
assert.equal(packageJson.dependencies['@capacitor-firebase/app-check'], '8.4.0');
assert.match(podfile, /pod 'CapacitorFirebaseAppCheck'/);
assert.match(webLogic, /X-Firebase-AppCheck/);
assert.match(webLogic, /hydrateNativePreferences\(\)/);
assert.match(metricKitService, /let manager = MXMetricManager\.shared[\s\S]*?manager\.add\(self\)/);
assert.match(metricKitService, /MetricKitOutbox/);
assert.match(metricKitService, /pastPayloads/);
assert.match(metricKitService, /maximumPendingReports/);
assert.match(metricKitService, /scheduleRetry\(\)/);
assert.match(
  await readFile(path.join(root, 'ios/App/App/AppDelegate.swift'), 'utf8'),
  /AppCheck\.setAppCheckProviderFactory[\s\S]*?FirebaseApp\.configure\(\)/,
  'يجب تعيين App Attest قبل تهيئة Firebase.'
);
assert.match(project, /AppTests\.xctest/);
assert.match(project, /AppUITests\.xctest/);
assert.match(scheme, /BlueprintName = "AppTests"/);
assert.match(scheme, /BlueprintName = "AppUITests"/);

assert.match(privacyManifest, /<key>NSPrivacyTracking<\/key>\s*<false\/>/);
assert.doesNotMatch(
  privacyManifest,
  /NSPrivacyCollectedDataTypeTracking<\/key>\s*<true\/>/,
  'فطنة لا تستخدم أي نوع بيانات للتتبع عبر التطبيقات أو المواقع.'
);

for (const dataType of [
  'NSPrivacyCollectedDataTypeUserID',
  'NSPrivacyCollectedDataTypeName',
  'NSPrivacyCollectedDataTypeEmailAddress',
  'NSPrivacyCollectedDataTypePhoneNumber',
  'NSPrivacyCollectedDataTypePurchaseHistory',
  'NSPrivacyCollectedDataTypeDeviceID',
  'NSPrivacyCollectedDataTypeOtherUserContent',
  'NSPrivacyCollectedDataTypeCrashData',
  'NSPrivacyCollectedDataTypeOtherDiagnosticData',
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
  /if\(!resp\.ok\)[\s\S]*?throw new Error[\s\S]*?showToast\('⚠️','ما قدرنا نحذف الحساب'[\s\S]*?return;/,
  'يجب إيقاف حذف Firebase والبيانات المحلية إذا لم يؤكد الخادم حذف البيانات.'
);
assert.match(
  webLogic,
  /await resetRevenueCatIdentity\(\);[\s\S]*?delete rcIds\[uid\]/,
  'يجب فصل هوية RevenueCat عند حذف الحساب حتى لا يعود اشتراك المستخدم المحذوف.'
);
assert.match(
  webLogic,
  /async function resetRevenueCatIdentity\(\)[\s\S]*?await RC\.logOut\(\)[\s\S]*?_rcReady=null;/,
  'يجب تسجيل الخروج من RevenueCat وتصفير تهيئته قبل دخول مستخدم جديد.'
);
assert.match(webApp, /href="https:\/\/apps\.apple\.com\/account\/subscriptions"/);
assert.match(webApp, /حذف حساب فطنة لا يلغي الاشتراك المتجدد/);
assert.match(
  privacyManifest,
  /NSPrivacyCollectedDataTypeOtherUserContent<\/string>[\s\S]*?NSPrivacyCollectedDataTypeLinked<\/key>\s*<true\/>/,
  'الفئات العائلية وتقدم اللعب مرتبطان بهوية المستخدم على الخادم.'
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
  /go\('s-loading'\);\s*void \(async \(\)=>\{[\s\S]*?checkSubscriptionAndRoute\(uid, \{showLoading:false\}\);/,
  'يجب عدم إظهار الاشتراك قبل التحقق من أهلية الجولة المجانية.'
);
assert.match(
  privacyManifest,
  /NSPrivacyCollectedDataTypeProductInteraction<\/string>[\s\S]*?NSPrivacyCollectedDataTypePurposeAnalytics<\/string>/,
  'يجب التصريح عن مؤشرات تفاعل اللعب المستخدمة للتحسين.'
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
assert.match(
  capacitorConfig,
  /providers:\s*\[[^\]]*'apple\.com'[^\]]*'google\.com'[^\]]*'phone'[^\]]*\]/,
  'يجب تفعيل مزود الهاتف في إضافة Firebase Authentication الأصلية.'
);
assert.match(
  podfile,
  /pod 'CapacitorFirebaseAuthentication\/Google'/,
  'إضافة google.com إلى capacitor.config لا تكفي؛ يجب تضمين Google subspec كي لا يعلق الاستدعاء الأصلي بلا نتيجة.'
);
assert.match(questionBank, /^window\.__QUESTION_BANK_DATA__ = \{/);
assert.ok(
  Buffer.byteLength(questionBank) > 20_000 && Buffer.byteLength(questionBank) < 100_000,
  'يجب أن يبقى بنك الأسئلة المحلي ضمن حجم مناسب للتطبيق.'
);
assert.equal(nativeWebApp, webApp, 'يجب مزامنة www مع نسخة iOS قبل البناء.');
assert.equal(nativeWebLogic, webLogic, 'يجب مزامنة JavaScript مع نسخة iOS قبل البناء.');
assert.equal(nativeWebStyles, webStyles, 'يجب مزامنة CSS مع نسخة iOS قبل البناء.');
assert.equal(nativeQuestionBank, questionBank, 'يجب مزامنة بنك الأسئلة مع نسخة iOS قبل البناء.');
assert.match(webLogic, /function normalizeQuestionBank\(bank\)/);
assert.match(webLogic, /function rememberQuestion\(cat,question\)/);
assert.match(webLogic, /state\.usedQuestionIds=new Set\(\)/);
assert.doesNotMatch(webLogic, /api\.anthropic\.com|AI_BACKEND_URL|aiGenerate\(/);
assert.match(webApp, /id="q-source"/);
assert.match(cloudFunction, /status\(410\)/);
assert.doesNotMatch(cloudFunction, /ANTHROPIC|api\.anthropic\.com|defineSecret/);

console.log('✓ لا يوجد طلب تتبع في iOS أو في Privacy Manifest');
console.log('✓ إفصاحات الخصوصية المعلنة في المشروع موجودة');
console.log('✓ Privacy Manifest مضمن في target وGame Center غير مفعّل');
console.log('✓ حذف الحساب لا يعلن نجاحاً قبل التحقق من Firebase');
console.log('✓ الهويات المحلية القديمة تُرقّى إلى Firebase عند توفرها');
console.log('✓ واجهة الإقلاع لا تنتظر الشبكة قبل الظهور');
console.log('✓ بنك الأسئلة المراجع مؤجل التحميل ومصادره ظاهرة داخل التطبيق');
console.log('✓ التوليد الآلي الخارجي متوقف وسجل عدم التكرار مربوط بالحساب');
