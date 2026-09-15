/**
 * فحوصات ثابتة لإعدادات خصوصية iOS التي يفحصها App Store Connect.
 *
 * تشغيل: node tests/ios_privacy_config_test.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const infoPlist = await readFile(path.join(root, 'ios/App/App/Info.plist'), 'utf8');
const privacyManifest = await readFile(path.join(root, 'ios/App/App/PrivacyInfo.xcprivacy'), 'utf8');
const project = await readFile(path.join(root, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8');
const entitlements = await readFile(path.join(root, 'ios/App/App/App.entitlements'), 'utf8');
const webApp = await readFile(path.join(root, 'www/index.html'), 'utf8');
const webLogic = await readFile(path.join(root, 'www/app.js'), 'utf8');
const gameLogic = await readFile(path.join(root, 'www/game-v2.js'), 'utf8');
const webStyles = await readFile(path.join(root, 'www/app.css'), 'utf8');
const privacyPolicy = await readFile(path.join(root, 'www/privacy-policy.html'), 'utf8');
const termsOfService = await readFile(path.join(root, 'www/terms-of-service.html'), 'utf8');
const nativeWebApp = await readFile(path.join(root, 'ios/App/App/public/index.html'), 'utf8');
const nativeWebLogic = await readFile(path.join(root, 'ios/App/App/public/app.js'), 'utf8');
const nativeGameLogic = await readFile(path.join(root, 'ios/App/App/public/game-v2.js'), 'utf8');
const nativeWebStyles = await readFile(path.join(root, 'ios/App/App/public/app.css'), 'utf8');
const appDelegate = await readFile(path.join(root, 'ios/App/App/AppDelegate.swift'), 'utf8');
const capacitorConfig = await readFile(path.join(root, 'capacitor.config.ts'), 'utf8');
const capacitorJsonConfig = JSON.parse(
  await readFile(path.join(root, 'capacitor.config.json'), 'utf8')
);
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
assert.match(
  entitlements,
  /com\.apple\.developer\.devicecheck\.appattest-environment<\/key>\s*<string>\$\(APP_ATTEST_ENVIRONMENT\)<\/string>/,
  'App Attest must resolve its environment from the active Xcode configuration.',
);
assert.match(project, /APP_ATTEST_ENVIRONMENT = development;/);
assert.match(project, /APP_ATTEST_ENVIRONMENT = production;/);
assert.equal(packageJson.dependencies['@capacitor-firebase/app-check'], '8.4.0');
assert.match(podfile, /pod 'CapacitorFirebaseAppCheck'/);
assert.match(webLogic, /X-Firebase-AppCheck/);
assert.match(webLogic, /hydrateNativePreferences\(\)/);
assert.match(metricKitService, /let manager = MXMetricManager\.shared[\s\S]*?manager\.add\(self\)/);
assert.match(metricKitService, /MetricKitOutbox/);
assert.match(metricKitService, /pastPayloads/);
assert.match(metricKitService, /maximumPendingReports/);
assert.match(metricKitService, /scheduleRetry\(\)/);
assert.match(metricKitService, /https:\/\/ata20\.com\/api\/v2\/ios-diagnostics/);
assert.doesNotMatch(
  webLogic,
  /setUserId\s*\(\s*\{\s*userId\s*:\s*uid\s*\}/,
  'لا يجوز ربط Crashlytics بحساب Firebase؛ تقارير الأعطال قد تُسلّم بعد تبديل الحساب.',
);
assert.match(webLogic, /setUserId\(\{userId:''\}\)/);
assert.match(
  metricKitService,
  /request\.setValue\("2", forHTTPHeaderField: "X-Fatinah-API-Version"\)/,
  'تقارير MetricKit في 1.3 يجب أن تمر بعقد v2 وإنفاذ App Check نفسه.',
);
assert.match(
  appDelegate,
  /AppCheck\.setAppCheckProviderFactory[\s\S]*?FirebaseApp\.configure\(\)/,
  'يجب تعيين App Attest قبل تهيئة Firebase.'
);
assert.doesNotMatch(
  appDelegate,
  /localizedDescription/,
  'لا تطبع رسالة خطأ iOS الخام؛ قد تتضمن رمزاً أو URL أو بيانات مستخدم.',
);
assert.doesNotMatch(
  metricKitService,
  /localizedDescription/,
  'لا تطبع رسالة رفع MetricKit الخام؛ اكتفِ بنوع الخطأ وحالة HTTP.',
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
  'NSPrivacyCollectedDataTypeCrashData',
  'NSPrivacyCollectedDataTypeOtherDiagnosticData',
]) {
  assert.match(privacyManifest, new RegExp(`<string>${dataType}<\\/string>`));
}
assert.match(
  privacyManifest,
  /NSPrivacyCollectedDataTypeOtherUserContent/,
  'بلاغ السؤال يجمع تفاصيل يكتبها اللاعب اختيارياً.',
);

assert.match(project, /PrivacyInfo\.xcprivacy in Resources/);
assert.match(
  project,
  /PLATFORM_NAME[^\n]+iphonesimulator/,
  'رفع dSYM إلى Crashlytics يجب ألا يعمل أثناء بناء المحاكي المحلي.',
);
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
  /async function resetRevenueCatIdentity\(\)[\s\S]*?clearRevenueCatAccessState\(\);[\s\S]*?RC_CURRENT_APP_USER_ID='';[\s\S]*?_rcReady=null;[\s\S]*?await RC\.logOut\(\)/,
  'يجب سحب صلاحية RevenueCat وتصفير الهوية محلياً قبل انتظار تسجيل الخروج الشبكي.'
);
assert.match(webApp, /href="https:\/\/apps\.apple\.com\/account\/subscriptions"/);
assert.match(webApp, /حذف حساب فطنة لا يلغي الاشتراك المتجدد/);
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
  /async function performSubscriptionCheck\(uid, generation, \{[\s\S]*?showLoading=true,[\s\S]*?serverTimeoutMs=15000,[\s\S]*?revenueCatTimeoutMs=12000,[\s\S]*?if\(showLoading && subscriptionCheckIsCurrent\(uid,generation\)\) go\('s-loading'\);/,
  'يجب أن يدعم فحص الاشتراك وضع الخلفية عند الإقلاع.'
);
assert.match(webLogic, /function subscriptionCheckIsCurrent\(uid,generation\)/,
  'نتيجة فحص الاشتراك يجب أن تكون مرتبطة بالحساب الحالي فقط.');
assert.doesNotMatch(webLogic, /\/api\/questions\//,
  'مسارات البنك القديمة يجب أن تبقى متوقفة.');
assert.doesNotMatch(webLogic, /script\.src='question-bank\.js'/,
  'لا يجوز شحن أو تحميل البنك القديم داخل التطبيق.');
assert.doesNotMatch(webLogic, /QUESTION_BANK|ALL_CATS|CAT_GROUPS|s-cats|s-board/);
assert.match(gameLogic, /packs\/readiness/);
assert.match(gameLogic, /ios-keychain-aesgcm/);
assert.match(gameLogic, /webcrypto-aesgcm/);
assert.match(webLogic, /const IS_NATIVE_APP=window\.Capacitor\?\.isNativePlatform\?\.\(\)===true;/);
assert.match(
  webLogic,
  /const API_ORIGIN = IS_NATIVE_APP\s*\? \(IS_NATIVE_LAN_TEST\?window\.location\.origin:'https:\/\/ata20\.com'\)\s*: '';/,
  'يجب أن تستخدم نسخة iOS خادم الإنتاج، مع قصر استثناء LAN على بيئة Xcode التجريبية.'
);
assert.match(webLogic, /const API_CONTRACT_VERSION='2';/);
assert.match(webLogic, /function versionedApiPath\(path\)/);
assert.match(webLogic, /`\/api\/v\$\{API_CONTRACT_VERSION\}\$\{value\.slice\(4\)\}`/);
assert.match(webLogic, /function apiUrl\(path\)\{ return `\$\{API_ORIGIN\}\$\{versionedApiPath\(path\)\}`; \}/);
assert.match(webLogic, /headers\.set\('X-Fatinah-API-Version',API_CONTRACT_VERSION\)/);
assert.match(capacitorConfig, /launchShowDuration:\s*700/);
const contentSecurityPolicy = webApp.match(
  /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i
)?.[1] || '';
assert.match(contentSecurityPolicy, /default-src 'none'/);
assert.match(contentSecurityPolicy, /base-uri 'none'/);
assert.match(contentSecurityPolicy, /form-action 'self'/);
assert.match(contentSecurityPolicy, /script-src-attr 'none'/);
for (const directive of ['script-src', 'script-src-elem', 'script-src-attr']) {
  const value = contentSecurityPolicy.match(
    new RegExp(`(?:^|;\\s*)${directive}\\s+([^;]+)`)
  )?.[1] || '';
  assert.doesNotMatch(value, /'unsafe-inline'|'unsafe-eval'/, `${directive} يجب أن يبقى صارماً.`);
}
assert.doesNotMatch(webApp, /\son[a-z]+\s*=/i, 'لا تسمح بمعالجات أحداث مضمّنة في HTML.');
assert.doesNotMatch(
  webLogic,
  /\s(?:onclick|oninput|onsubmit|onkeydown)\s*=/,
  'القوالب الديناميكية لا يجوز أن تعيد إنشاء event-handler attributes.',
);
for (const match of webApp.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  assert.match(match[1], /\bsrc=/i, 'كل JavaScript في واجهة اللعبة يجب أن يأتي من ملف self-hosted.');
  assert.equal(match[2].trim(), '', 'لا تضف كوداً داخل وسم script.');
}
for (const legalDocument of [privacyPolicy, termsOfService]) {
  const legalCsp = legalDocument.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i
  )?.[1] || '';
  assert.match(legalCsp, /script-src 'none'/);
  assert.match(legalCsp, /script-src-attr 'none'/);
  assert.doesNotMatch(legalDocument, /\son[a-z]+\s*=/i);
  assert.match(legalDocument, /<a class="back-btn" href="index\.html">/);
}
const appBoundDomainsSetting = capacitorConfig.match(
  /limitsNavigationsToAppBoundDomains:\s*(true|false)/
);
assert.ok(appBoundDomainsSetting, 'يجب تعريف إعداد App-Bound Domains صراحةً في مصدر TypeScript.');
const appBoundDomainsEnabled = appBoundDomainsSetting[1] === 'true';
assert.equal(
  capacitorJsonConfig.ios?.limitsNavigationsToAppBoundDomains,
  appBoundDomainsEnabled,
  'capacitor.config.json مرآة توافق فقط ويجب أن يطابق مصدر TypeScript.'
);
if (!/<key>WKAppBoundDomains<\/key>/.test(infoPlist)) {
  assert.equal(
    appBoundDomainsEnabled,
    false,
    'لا تفعّل limitsNavigationsToAppBoundDomains من دون WKAppBoundDomains في Info.plist.'
  );
}
assert.match(
  capacitorConfig,
  /providers:\s*\[[^\]]*'apple\.com'[^\]]*'google\.com'[^\]]*'phone'[^\]]*\]/,
  'يجب تفعيل مزود الهاتف في إضافة Firebase Authentication الأصلية.'
);
assert.deepEqual(
  capacitorJsonConfig.plugins?.FirebaseAuthentication?.providers,
  ['apple.com', 'google.com', 'phone'],
  'يجب أن تعكس نسخة JSON مزودي المصادقة المحددين في مصدر TypeScript.'
);
assert.match(
  podfile,
  /pod 'CapacitorFirebaseAuthentication\/Google'/,
  'إضافة google.com إلى capacitor.config لا تكفي؛ يجب تضمين Google subspec كي لا يعلق الاستدعاء الأصلي بلا نتيجة.'
);
assert.equal(nativeWebApp, webApp, 'يجب مزامنة www مع نسخة iOS قبل البناء.');
assert.equal(nativeWebLogic, webLogic, 'يجب مزامنة JavaScript مع نسخة iOS قبل البناء.');
assert.equal(nativeGameLogic, gameLogic, 'يجب مزامنة منطق الجولة الجديدة مع نسخة iOS قبل البناء.');
assert.equal(nativeWebStyles, webStyles, 'يجب مزامنة CSS مع نسخة iOS قبل البناء.');
assert.doesNotMatch(webLogic, /api\.anthropic\.com|AI_BACKEND_URL|aiGenerate\(/);
assert.doesNotMatch(webApp, /id="q-source"|id="q-wrap"|id="question-report-modal"/);

console.log('✓ لا يوجد طلب تتبع في iOS أو في Privacy Manifest');
console.log('✓ إفصاحات الخصوصية المعلنة في المشروع موجودة');
console.log('✓ Privacy Manifest مضمن في target وGame Center غير مفعّل');
console.log('✓ حذف الحساب لا يعلن نجاحاً قبل التحقق من Firebase');
console.log('✓ الهويات المحلية القديمة تُرقّى إلى Firebase عند توفرها');
console.log('✓ واجهة الإقلاع لا تنتظر الشبكة قبل الظهور');
console.log('✓ إعدادا Capacitor متطابقان وApp-Bound Domains غير مفعّل بلا قائمة نطاقات');
console.log('✓ تطبيق 1.4 بلا فئات أو بنك قديم، وحزمتا المشترك القادمتان مشفرتان');
