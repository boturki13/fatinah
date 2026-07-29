/**
 * اختبارات دالة checkSubscriptionAndRoute
 * تتحقق أن fail-open يعمل فعلاً في جميع الحالات الحدية
 *
 * تشغيل: node tests/subscription_routing_test.mjs
 */

import assert from 'node:assert/strict';

// ─── نسخة مستخلصة من checkSubscriptionAndRoute (index.html) ─────────────────
// تُحاكي نفس المنطق بدون اعتماد على DOM أو Firebase
async function checkSubscriptionAndRoute(uid, { rcIsActive, go, fetchFn, promoIsActive }) {
  const rcActive = await rcIsActive();

  if (rcActive === true) {
    // iOS: اذهب للصفحة الرئيسية فوراً
    go('s-home');
    // تحقق خلفي من الخادم (fail-open)
    if (uid) {
      try {
        const resp = await fetchFn(`/api/stripe/status?uid=${encodeURIComponent(uid)}`);
        if (resp.ok) {
          const data = await resp.json();
          // فقط active:false صراحةً → paywall
          if (data.active === false) {
            go('s-paywall');
          }
        }
        // أي رد آخر (غير ok، أو active:true) → يبقى في s-home (fail-open)
      } catch (e) {
        // انقطاع الشبكة أو خطأ خادم → يبقى في s-home (fail-open)
      }
    }
    return;
  }

  if (rcActive === false) {
    if (uid && await promoIsActive(uid)) { go('s-home'); return; }
    go('s-paywall'); return;
  }

  // ويب: Stripe — fail-closed
  try {
    const resp = await fetchFn(`/api/stripe/status?uid=${encodeURIComponent(uid)}`);
    if (!resp.ok) throw new Error('status error');
    const data = await resp.json();
    if (data.active === true) { go('s-home'); return; }
    if (uid && await promoIsActive(uid)) { go('s-home'); return; }
    go('s-paywall');
  } catch (e) {
    if (uid && await promoIsActive(uid)) { go('s-home'); return; }
    go('s-paywall');
  }
}

// ─── مساعدات ─────────────────────────────────────────────────────────────────
function makeGoTracker() {
  const history = [];
  return {
    go: (screen) => history.push(screen),
    history,
    last: () => history[history.length - 1],
  };
}

function makeFetch(status, body) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

function makeNetworkErrorFetch() {
  return async () => { throw new TypeError('Failed to fetch'); };
}

const noPromo = async () => false;
const rcTrue  = async () => true;

// ─── الاختبارات ──────────────────────────────────────────────────────────────
const tests = [];

// 1. الخادم يُعيد 500 → المستخدم يبقى في s-home (fail-open)
tests.push(async function test_server_500_stays_home() {
  const tracker = makeGoTracker();
  await checkSubscriptionAndRoute('uid-123', {
    rcIsActive:   rcTrue,
    go:           tracker.go,
    fetchFn:      makeFetch(500, {}),
    promoIsActive: noPromo,
  });
  assert.equal(tracker.last(), 's-home',
    'يجب أن يبقى في s-home عند خطأ 500 من الخادم');
  console.log('  ✓ خطأ 500 → يبقى في s-home');
});

// 2. انقطاع الشبكة → المستخدم يبقى في s-home (fail-open)
tests.push(async function test_network_error_stays_home() {
  const tracker = makeGoTracker();
  await checkSubscriptionAndRoute('uid-123', {
    rcIsActive:   rcTrue,
    go:           tracker.go,
    fetchFn:      makeNetworkErrorFetch(),
    promoIsActive: noPromo,
  });
  assert.equal(tracker.last(), 's-home',
    'يجب أن يبقى في s-home عند انقطاع الشبكة');
  console.log('  ✓ انقطاع الشبكة → يبقى في s-home');
});

// 3. الخادم يُعيد active:false → المستخدم يذهب لـ s-paywall
tests.push(async function test_server_active_false_goes_paywall() {
  const tracker = makeGoTracker();
  await checkSubscriptionAndRoute('uid-123', {
    rcIsActive:   rcTrue,
    go:           tracker.go,
    fetchFn:      makeFetch(200, { active: false }),
    promoIsActive: noPromo,
  });
  assert.equal(tracker.last(), 's-paywall',
    'يجب أن يذهب لـ s-paywall عند active:false من الخادم');
  console.log('  ✓ active:false → يذهب لـ s-paywall');
});

// 4. الخادم يُعيد active:true → المستخدم يبقى في s-home
tests.push(async function test_server_active_true_stays_home() {
  const tracker = makeGoTracker();
  await checkSubscriptionAndRoute('uid-123', {
    rcIsActive:   rcTrue,
    go:           tracker.go,
    fetchFn:      makeFetch(200, { active: true }),
    promoIsActive: noPromo,
  });
  assert.equal(tracker.last(), 's-home',
    'يجب أن يبقى في s-home عند active:true من الخادم');
  console.log('  ✓ active:true → يبقى في s-home');
});

// ─── تشغيل ───────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

console.log('\nاختبارات fail-open في checkSubscriptionAndRoute\n');

for (const test of tests) {
  try {
    await test();
    passed++;
  } catch (e) {
    failed++;
    console.error(`  ✗ ${test.name}: ${e.message}`);
  }
}

console.log(`\nالنتيجة: ${passed} نجح / ${failed} فشل\n`);

if (failed > 0) {
  process.exit(1);
}
