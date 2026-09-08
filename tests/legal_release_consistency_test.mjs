import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = relativePath => readFile(new URL(relativePath, root), 'utf8');

const [
  metadata,
  packageJson,
  project,
  nextReleasePlan,
  bundledPrivacy,
  bundledTerms,
  publicPrivacy,
  publicTerms,
] = await Promise.all([
  read('release/current.json').then(JSON.parse),
  read('package.json').then(JSON.parse),
  read('ios/App/App.xcodeproj/project.pbxproj'),
  read('docs/NEXT_RELEASE.md'),
  read('www/privacy-policy.html'),
  read('www/terms-of-service.html'),
  read('legal/privacy.html'),
  read('legal/terms.html'),
]);

assert.equal(packageJson.version, metadata.packageVersion);
assert.match(project, new RegExp(`MARKETING_VERSION = ${metadata.iosMarketingVersion.replace('.', '\\.')};`));
assert.match(project, new RegExp(`CURRENT_PROJECT_VERSION = ${metadata.iosBuild};`));
for (const currentReleaseMarker of [
  `الإصدار \`${metadata.packageVersion}\``,
  `Marketing Version رقم \`${metadata.iosMarketingVersion}\``,
  `البناء \`${metadata.iosBuild}\``,
]) {
  assert.ok(
    nextReleasePlan.includes(currentReleaseMarker),
    `يجب أن تذكر خطة التحديث بوضوح بيانات الإصدار الحالي: ${currentReleaseMarker}`,
  );
}
assert.match(nextReleasePlan, /مرشح إصدار فطنة 1\.4\.0/);
if (metadata.appStoreState === 'testflight_ready_to_submit') {
  assert.match(nextReleasePlan, /بناء TestFlight جاهز للإرسال، ولم يُنشأ tag أو يُنشر خادم 1\.4 بعد/,
    'مرشح 1.4 يجب أن يوثق حالة TestFlight والخادم بدقة');
} else if (metadata.appStoreState === 'testflight_internal_testing') {
  assert.match(nextReleasePlan, /البناء في اختبار TestFlight الداخلي، ولم يُنشأ tag أو يُنشر خادم 1\.4 بعد/,
    'مرشح 1.4 يجب أن يفصل بين اختبار TestFlight ونشر الخادم');
} else {
  assert.equal(metadata.appStoreState, 'not_submitted');
  assert.match(nextReleasePlan, /لم يُنشأ tag ولم يُرفع التطبيق بعد/,
    'مرشح 1.4 يجب ألا يدّعي إنشاء tag أو رفعاً لم يحدث');
}

for (const [name, document] of [
  ['سياسة الخصوصية داخل التطبيق', bundledPrivacy],
  ['سياسة الخصوصية العامة', publicPrivacy],
]) {
  assert.doesNotMatch(document, /مناسب لجميع الأعمار|موجّه لجميع الأعمار|suitable for all ages/iu, `${name}: يحظر وصف التطبيق بأنه لجميع الأعمار.`);
  assert.match(document, /دون ١٣ عاماً/iu, `${name}: يجب ذكر حد 13 عاماً.`);
  assert.match(document, /دون ١٦ عاماً/iu, `${name}: يجب ذكر حد 16 عاماً حيث يلزم.`);
}

for (const [name, document] of [
  ['شروط الاستخدام داخل التطبيق', bundledTerms],
  ['شروط الاستخدام العامة', publicTerms],
]) {
  assert.match(document, /يجب ألا يقل عمرك عن ١٣ عاماً/iu, `${name}: يجب أن يطابق حد العمر سياسة الخصوصية.`);
}

assert.match(publicPrivacy, /not directed at children under 13 \(or under 16 where required\)/i);
assert.match(publicTerms, /must be at least 13 years old to use the app/i);

console.log(`✓ بيانات مرشح الإصدار ${metadata.packageVersion} (${metadata.iosBuild}) متسقة مع حالة TestFlight والخادم`);
console.log('✓ حدود العمر متسقة بين السياسات والشروط المدمجة والعامة');
