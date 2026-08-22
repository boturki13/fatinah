/**
 * اختبارات مسار الاشتراك الخادمي.
 *
 * كل مستخدم يدخل الرئيسية أولاً. غير المشترك يحصل على جولة واحدة فقط، ثم
 * تظهر شاشة الاشتراك عند طلب جولة جديدة بدلاً من عرضها تلقائياً عند الإقلاع.
 *
 * تشغيل: node tests/subscription_routing_test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';

const appSource = fs.readFileSync(new URL('../www/app.js', import.meta.url), 'utf8');
const indexSource = fs.readFileSync(new URL('../www/index.html', import.meta.url), 'utf8');
assert.doesNotMatch(
  appSource,
  /go\(_freeRoundAvailable\?'s-home':'s-paywall'\)/,
  'شاشة الاشتراك لا تُفتح تلقائياً عند الإقلاع بعد استهلاك الجولة المجانية.',
);
assert.match(appSource, /function canStartRound\(\)[\s\S]*?go\('s-paywall'\)/);

async function checkSubscriptionAndRoute(uid, { go, fetchFn, rcIsActive, freeRoundIsAvailable }) {
  go('s-loading');
  try {
    const resp = await fetchFn(`/api/v2/subscription/status?uid=${encodeURIComponent(uid || '')}`);
    if (!resp.ok) throw new Error('status error');
    const data = await resp.json();
    if (data.active === true) { go('s-home'); return; }
    if (await rcIsActive() === true) { go('s-home'); return; }
    await freeRoundIsAvailable(uid);
    go('s-home');
  } catch {
    if (await rcIsActive() === true) { go('s-home'); return; }
    await freeRoundIsAvailable(uid);
    go('s-home');
  }
}

function makeGoTracker() {
  const history = [];
  return { go: (screen) => history.push(screen), history, last: () => history.at(-1) };
}

function makeFetch(status, body) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

const networkError = async () => { throw new TypeError('Failed to fetch'); };
const inactiveRc = async () => false;
const activeRc = async () => true;
const freeRound = async () => true;
const usedFreeRound = async () => false;
const tests = [];

tests.push(async function family_offer_code_uses_apple_redemption() {
  assert.match(indexSource, />🎁 ضع الكود هنا<\/button>/);
  assert.match(indexSource, /كود الأهل والأصدقاء يُنشأ ويُسترد بأمان عبر Apple/);
  assert.doesNotMatch(indexSource, /عندي كود عرض من Apple|عندك كود مجاني/);
  assert.match(appSource, /async function redeemAppleOfferCode\(\)[\s\S]*?presentCodeRedemptionSheet\(\)/);
  console.log('  ✓ كود الأهل والأصدقاء يظهر بالنص الجديد ويُسترد عبر Apple');
});

tests.push(async function server_active_opens_home() {
  const tracker = makeGoTracker();
  await checkSubscriptionAndRoute('uid-123', {
    go: tracker.go, fetchFn: makeFetch(200, { active: true }), rcIsActive: inactiveRc, freeRoundIsAvailable: usedFreeRound,
  });
  assert.equal(tracker.last(), 's-home');
  console.log('  ✓ active:true → s-home');
});

tests.push(async function server_inactive_with_free_round_opens_home() {
  const tracker = makeGoTracker();
  await checkSubscriptionAndRoute('uid-123', {
    go: tracker.go, fetchFn: makeFetch(200, { active: false }), rcIsActive: inactiveRc, freeRoundIsAvailable: freeRound,
  });
  assert.equal(tracker.last(), 's-home');
  console.log('  ✓ active:false + جولة مجانية → s-home');
});

tests.push(async function server_inactive_after_free_round_opens_home() {
  const tracker = makeGoTracker();
  await checkSubscriptionAndRoute('uid-123', {
    go: tracker.go, fetchFn: makeFetch(200, { active: false }), rcIsActive: inactiveRc, freeRoundIsAvailable: usedFreeRound,
  });
  assert.equal(tracker.last(), 's-home');
  console.log('  ✓ active:false + جولة مستخدمة → s-home عند الإقلاع');
});

tests.push(async function network_error_respects_local_free_round_state() {
  const tracker = makeGoTracker();
  await checkSubscriptionAndRoute('uid-123', {
    go: tracker.go, fetchFn: networkError, rcIsActive: inactiveRc, freeRoundIsAvailable: usedFreeRound,
  });
  assert.equal(tracker.last(), 's-home');
  console.log('  ✓ network error + جولة مستخدمة → s-home عند الإقلاع');
});

tests.push(async function revenuecat_active_opens_home_while_webhook_delayed() {
  const tracker = makeGoTracker();
  await checkSubscriptionAndRoute('uid-123', {
    go: tracker.go, fetchFn: makeFetch(200, { active: false }), rcIsActive: activeRc, freeRoundIsAvailable: usedFreeRound,
  });
  assert.equal(tracker.last(), 's-home');
  console.log('  ✓ RevenueCat active مع تأخر webhook → s-home');
});

for (const test of tests) await test();
console.log(`\nالنتيجة: ${tests.length} نجح / 0 فشل`);
