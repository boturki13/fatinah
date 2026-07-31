/**
 * اختبارات مسار الاشتراك الخادمي.
 *
 * لا تُستخدم حالة RevenueCat المحلية لمنح الصلاحية؛
 * webhook الخادمي هو المصدر الوحيد للحالة الحساسة.
 *
 * تشغيل: node tests/subscription_routing_test.mjs
 */

import assert from 'node:assert/strict';

async function checkSubscriptionAndRoute(uid, { go, fetchFn, promoIsActive }) {
  go('s-loading');
  try {
    const resp = await fetchFn(`/api/subscription/status?uid=${encodeURIComponent(uid || '')}`);
    if (!resp.ok) throw new Error('status error');
    const data = await resp.json();
    if (data.active === true) { go('s-home'); return; }
    if (uid && await promoIsActive(uid)) { go('s-home'); return; }
    go('s-paywall');
  } catch {
    if (uid && await promoIsActive(uid)) { go('s-home'); return; }
    go('s-paywall');
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
const noPromo = async () => false;
const activePromo = async () => true;
const tests = [];

tests.push(async function server_active_opens_home() {
  const tracker = makeGoTracker();
  await checkSubscriptionAndRoute('uid-123', {
    go: tracker.go, fetchFn: makeFetch(200, { active: true }), promoIsActive: noPromo,
  });
  assert.equal(tracker.last(), 's-home');
  console.log('  ✓ active:true → s-home');
});

tests.push(async function server_inactive_goes_paywall() {
  const tracker = makeGoTracker();
  await checkSubscriptionAndRoute('uid-123', {
    go: tracker.go, fetchFn: makeFetch(200, { active: false }), promoIsActive: noPromo,
  });
  assert.equal(tracker.last(), 's-paywall');
  console.log('  ✓ active:false → s-paywall');
});

tests.push(async function server_error_fails_closed() {
  const tracker = makeGoTracker();
  await checkSubscriptionAndRoute('uid-123', {
    go: tracker.go, fetchFn: makeFetch(500, {}), promoIsActive: noPromo,
  });
  assert.equal(tracker.last(), 's-paywall');
  console.log('  ✓ server 500 → s-paywall');
});

tests.push(async function network_error_fails_closed() {
  const tracker = makeGoTracker();
  await checkSubscriptionAndRoute('uid-123', {
    go: tracker.go, fetchFn: networkError, promoIsActive: noPromo,
  });
  assert.equal(tracker.last(), 's-paywall');
  console.log('  ✓ network error → s-paywall');
});

tests.push(async function active_promo_opens_home() {
  const tracker = makeGoTracker();
  await checkSubscriptionAndRoute('uid-123', {
    go: tracker.go, fetchFn: makeFetch(200, { active: false }), promoIsActive: activePromo,
  });
  assert.equal(tracker.last(), 's-home');
  console.log('  ✓ active promo → s-home');
});

for (const test of tests) await test();
console.log(`\nالنتيجة: ${tests.length} نجح / 0 فشل`);