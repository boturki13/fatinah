/**
 * اختبارات أسعار الـ Paywall المسحوبة من StoreKit عبر RevenueCat.
 *
 * كل الأسعار المعروضة في الواجهة (بطاقات الخطط، زر الشراء، شاشة الشروط)
 * يجب أن تأتي من priceString/price الحقيقية التي يرجعها RC.getOfferings() —
 * بلا أي رقم ثابت مكتوب يدوياً (App Store Guideline 3.1.2).
 *
 * تشغيل: node tests/paywall_prices_test.mjs
 * يتطلب: playwright + متصفح Chromium مثبّت (npx playwright install chromium)
 */

import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE_URL = 'file://' + path.resolve(__dirname, '..', 'www', 'index.html');

function product({ priceString, price, currencyCode }) {
  return { priceString, price, currencyCode };
}

// شكل PurchasesPackage الحقيقي — معرّفات RevenueCat الافتراضية هي
// $rc_monthly/$rc_annual لا "monthly"/"annual"
function makePackage(plan, productData) {
  return {
    identifier: '$rc_' + plan,
    packageType: plan === 'annual' ? 'ANNUAL' : 'MONTHLY',
    offeringIdentifier: 'default',
    product: productData,
  };
}

// شكل PurchasesOfferings الحقيقي كما يرجعه RC.getOfferings() مباشرة —
// {all, current} بلا مفتاح "offerings" يغلّفه (راجع definitions.d.ts)
function offeringsWith({ monthly, annual } = {}) {
  const monthlyPkg = monthly ? makePackage('monthly', monthly) : null;
  const annualPkg = annual ? makePackage('annual', annual) : null;
  const availablePackages = [monthlyPkg, annualPkg].filter(Boolean);
  const offering = {
    identifier: 'default',
    serverDescription: '',
    metadata: {},
    webCheckoutUrl: null,
    monthly: monthlyPkg,
    annual: annualPkg,
    lifetime: null,
    sixMonth: null,
    threeMonth: null,
    twoMonth: null,
    weekly: null,
    availablePackages,
  };
  const hasAny = availablePackages.length > 0;
  return {
    all: hasAny ? { default: offering } : {},
    current: hasAny ? offering : null,
  };
}

// تُشغَّل داخل صفحة المتصفح — لا وصول لمتغيرات Node، كل شيء يُمرَّر عبر arg
// configureDelayMs: يحاكي زمن RC.configure() الحقيقي على الجهاز (شبكة + Keychain)،
// وgetOfferings يرمي "There is no singleton instance" (خطأ RevenueCat الحقيقي)
// طالما configure() لم يخلص بعد — هذا هو سباق التهيئة عند الإقلاع.
function installCapacitorStub({ authUid, rcApiKey, offeringsResult, shouldThrow, configureDelayMs, purchaseError }) {
  if (authUid) localStorage.setItem('fatinah_authUid', JSON.stringify(authUid));
  let configured = false;
  window.__rcTest = { purchaseCalls: 0, restoreCalls: 0 };
  window.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      FirebaseAuthentication: {
        getCurrentUser: () => Promise.resolve({ user: { uid: authUid || 'test-uid', isAnonymous: true } }),
        getIdToken: () => Promise.resolve({ token: 'test-id-token' }),
        signInAnonymously: () => Promise.resolve({ user: { uid: authUid || 'test-uid', isAnonymous: true } }),
      },
      RevenueCatKeyStore: {
        get: () => Promise.resolve({ value: rcApiKey || '' }),
        set: () => Promise.resolve(),
        clear: () => Promise.resolve(),
      },
      FirebaseCrashlytics: {
        setEnabled: () => Promise.resolve(),
        recordException: () => Promise.resolve(),
        setUserId: () => Promise.resolve(),
      },
      Purchases: {
        configure: () =>
          new Promise((resolve) => {
            setTimeout(() => {
              configured = true;
              resolve();
            }, configureDelayMs || 0);
          }),
        getOfferings: () => {
          if (!configured) return Promise.reject(new Error('There is no singleton instance'));
          return shouldThrow
            ? Promise.reject(new Error(shouldThrow))
            : Promise.resolve(offeringsResult);
        },
        purchasePackage: () => {
          window.__rcTest.purchaseCalls++;
          return purchaseError
            ? Promise.reject(Object.assign(new Error(purchaseError.message), { code: purchaseError.code }))
            : Promise.resolve({ customerInfo: { entitlements: { active: {} } } });
        },
        restorePurchases: () => {
          window.__rcTest.restoreCalls++;
          return Promise.resolve({});
        },
      },
    },
  };
}

async function withPage(fn) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    // اقطع كل الشبكة افتراضياً — لا يصل أي طلب حقيقي للإنترنت أثناء الاختبار
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith('file://')) return route.continue();
      return route.abort();
    });
    // زوّر نقطة نهاية مفتاح RevenueCat حتى يتهيّأ الـ SDK محلياً
    await page.route('**/api/rc-config', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ apiKey: 'appl_TESTKEY' }),
      })
    );
    // زوّر ربط الهوية حتى يكمل initRevenueCat() إلى RC.configure()
    await page.route('**/api/revenuecat/identity', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    );
    await fn(page);
    await context.close();
  } finally {
    await browser.close();
  }
}

async function gotoPaywall(page, offeringsResult, shouldThrow, options = {}) {
  await page.addInitScript(installCapacitorStub, {
    authUid: 'test-uid-001',
    rcApiKey: 'appl_TESTKEY',
    offeringsResult,
    shouldThrow,
    purchaseError: options.purchaseError,
    configureDelayMs: 0,
  });
  await page.goto(FILE_URL);
  await page.evaluate(() => window.go('s-paywall'));
  await page.waitForFunction(
    () => {
      const btn = document.getElementById('paywall-btn');
      const err = document.getElementById('pw-price-error');
      return (err && err.style.display !== 'none') || (btn && !btn.disabled);
    },
    { timeout: 8000 }
  );
}

async function gotoPaywallNoCapacitor(page) {
  await page.addInitScript(() => {
    window.FIREBASE_CONFIGURED = false;
    localStorage.setItem('fatinah_authProvider', JSON.stringify('local'));
    localStorage.setItem('fatinah_authUid', JSON.stringify('web-test-user'));
  });
  await page.goto(FILE_URL);
  await page.evaluate(() => window.go('s-paywall'));
  await page.waitForFunction(
    () => {
      const note = document.getElementById('web-payment-note');
      return note && note.style.display !== 'none';
    },
    { timeout: 8000 }
  );
}

async function readPaywall(page) {
  return page.evaluate(() => ({
    monthlyPrice: document.getElementById('pw-monthly-price').textContent,
    annualPrice: document.getElementById('pw-annual-price').textContent,
    annualSub: document.getElementById('pw-annual-sub').textContent,
    badgeText: document.getElementById('pw-annual-badge').textContent,
    badgeHidden: document.getElementById('pw-annual-badge').hidden,
    ctaSub: document.getElementById('pw-cta-sub').textContent,
    termsMonthly: document.getElementById('terms-monthly-price').textContent,
    termsAnnual: document.getElementById('terms-annual-price').textContent,
    btnDisabled: document.getElementById('paywall-btn').disabled,
    btnDisplay: getComputedStyle(document.getElementById('paywall-btn')).display,
    errDisplay: getComputedStyle(document.getElementById('pw-price-error')).display,
    noteDisplay: getComputedStyle(document.getElementById('web-payment-note')).display,
    planMonthlyDisplay: getComputedStyle(document.getElementById('pw-plan-monthly')).display,
    planAnnualDisplay: getComputedStyle(document.getElementById('pw-plan-annual')).display,
  }));
}

const tests = [];

tests.push(async function usd_prices() {
  await withPage(async (page) => {
    const offerings = offeringsWith({
      monthly: product({ priceString: '$3.99', price: 3.99, currencyCode: 'USD' }),
      annual: product({ priceString: '$29.99', price: 29.99, currencyCode: 'USD' }),
    });
    await gotoPaywall(page, offerings);
    const r = await readPaywall(page);
    assert.equal(r.monthlyPrice, '$3.99');
    assert.equal(r.annualPrice, '$29.99');
    assert.equal(r.annualSub, 'يعادل $2.49 شهرياً فقط');
    assert.equal(r.badgeHidden, false);
    assert.equal(r.badgeText, 'الأفضل قيمة · وفّر 37%');
    assert.ok(r.ctaSub.includes('$3.99 / شهر — تُلغى في أي وقت'), `ctaSub: ${r.ctaSub}`);
    assert.equal(r.termsMonthly, '$3.99 شهرياً');
    assert.equal(r.termsAnnual, '$29.99 سنوياً');
    assert.equal(r.btnDisabled, false);
    assert.notEqual(r.btnDisplay, 'none');
  });
  console.log('  ✓ USD: $3.99/$29.99، يعادل $2.49، توفير 37%');
});

tests.push(async function gbp_prices() {
  await withPage(async (page) => {
    const offerings = offeringsWith({
      monthly: product({ priceString: '£3.49', price: 3.49, currencyCode: 'GBP' }),
      annual: product({ priceString: '£24.99', price: 24.99, currencyCode: 'GBP' }),
    });
    await gotoPaywall(page, offerings);
    const r = await readPaywall(page);
    assert.equal(r.monthlyPrice, '£3.49');
    assert.equal(r.annualPrice, '£24.99');
    assert.equal(r.annualSub, 'يعادل £2.08 شهرياً فقط');
    assert.equal(r.badgeHidden, false);
    assert.equal(r.badgeText, 'الأفضل قيمة · وفّر 40%');
    assert.ok(r.ctaSub.includes('£3.49 / شهر — تُلغى في أي وقت'), `ctaSub: ${r.ctaSub}`);
    assert.equal(r.termsMonthly, '£3.49 شهرياً');
    assert.equal(r.termsAnnual, '£24.99 سنوياً');
    assert.equal(r.btnDisabled, false);
  });
  console.log('  ✓ GBP: £3.49/£24.99، يعادل £2.08، توفير 40%');
});

tests.push(async function sar_prices() {
  await withPage(async (page) => {
    const offerings = offeringsWith({
      monthly: product({ priceString: 'SAR 14.99', price: 14.99, currencyCode: 'SAR' }),
      annual: product({ priceString: 'SAR 119.99', price: 119.99, currencyCode: 'SAR' }),
    });
    await gotoPaywall(page, offerings);
    const r = await readPaywall(page);
    assert.equal(r.monthlyPrice, 'SAR 14.99');
    assert.equal(r.annualPrice, 'SAR 119.99');
    assert.equal(r.annualSub, 'يعادل SAR 9.99 شهرياً فقط');
    assert.equal(r.badgeHidden, false);
    assert.equal(r.badgeText, 'الأفضل قيمة · وفّر 33%');
    assert.ok(r.ctaSub.includes('SAR 14.99 / شهر — تُلغى في أي وقت'), `ctaSub: ${r.ctaSub}`);
    assert.equal(r.termsMonthly, 'SAR 14.99 شهرياً');
    assert.equal(r.termsAnnual, 'SAR 119.99 سنوياً');
    assert.equal(r.btnDisabled, false);
  });
  console.log('  ✓ SAR: SAR 14.99/SAR 119.99، يعادل SAR 9.99، توفير 33%');
});

tests.push(async function jpy_prices_no_thousands_separator_bug() {
  await withPage(async (page) => {
    // ¥4,500 — الفاصلة هنا فاصلة آلاف لا عشرية؛ استنتاج الخانات العشرية من
    // شكل النص (بدل معيار العملة عبر Intl) يعطي نتيجة خاطئة مثل ¥375.000
    const offerings = offeringsWith({
      monthly: product({ priceString: '¥600', price: 600, currencyCode: 'JPY' }),
      annual: product({ priceString: '¥4,500', price: 4500, currencyCode: 'JPY' }),
    });
    await gotoPaywall(page, offerings);
    const r = await readPaywall(page);
    assert.equal(r.monthlyPrice, '¥600');
    assert.equal(r.annualPrice, '¥4,500');
    assert.equal(r.annualSub, 'يعادل ¥375 شهرياً فقط');
    assert.equal(r.badgeHidden, false);
    assert.equal(r.badgeText, 'الأفضل قيمة · وفّر 38%');
    assert.ok(r.ctaSub.includes('¥600 / شهر — تُلغى في أي وقت'), `ctaSub: ${r.ctaSub}`);
    assert.equal(r.termsMonthly, '¥600 شهرياً');
    assert.equal(r.termsAnnual, '¥4,500 سنوياً');
    assert.equal(r.btnDisabled, false);
  });
  console.log('  ✓ JPY: ¥600/¥4,500، يعادل ¥375 بلا كسور (لا خطأ فاصلة الآلاف)، توفير 38%');
});

tests.push(async function annual_only_hides_monthly_card() {
  await withPage(async (page) => {
    const offerings = offeringsWith({
      annual: product({ priceString: '$29.99', price: 29.99, currencyCode: 'USD' }),
    });
    await gotoPaywall(page, offerings);
    const r = await readPaywall(page);
    assert.equal(r.planMonthlyDisplay, 'none', 'بطاقة الشهري يجب أن تختفي بالكامل');
    assert.notEqual(r.planAnnualDisplay, 'none');
    assert.equal(r.monthlyPrice, '', 'لا يوجد سعر شهري وهمي');
    assert.equal(r.annualPrice, '$29.99');
    assert.equal(r.badgeHidden, true, 'لا نسبة توفير بلا سعر شهري للمقارنة');
    assert.equal(r.termsMonthly, '—');
    assert.equal(r.termsAnnual, '$29.99 سنوياً');
    assert.ok(r.ctaSub.includes('$29.99 / سنة'), `يجب تحويل الاختيار للخطة السنوية المتاحة: ${r.ctaSub}`);
    assert.equal(r.btnDisabled, false, 'الزر يبقى مفعّلاً لأن هناك خطة صالحة واحدة على الأقل');
  });
  console.log('  ✓ باقة سنوية فقط: تختفي بطاقة الشهري، الاختيار يتحوّل للسنوي، بلا نسبة توفير');
});

tests.push(async function get_offerings_failure_disables_button() {
  await withPage(async (page) => {
    await gotoPaywall(page, null, 'network down');
    const r = await readPaywall(page);
    assert.notEqual(r.errDisplay, 'none', 'رسالة الخطأ يجب أن تظهر');
    assert.equal(r.btnDisabled, true, 'الزر يبقى معطّلاً — لا شراء بسعر غير معروف');
    assert.equal(r.monthlyPrice, '');
    assert.equal(r.annualPrice, '');
  });
  console.log('  ✓ فشل getOfferings: رسالة الخطأ تظهر والزر يبقى disabled');
});

tests.push(async function web_without_capacitor_hides_purchase() {
  await withPage(async (page) => {
    await gotoPaywallNoCapacitor(page);
    const r = await readPaywall(page);
    assert.equal(r.btnDisplay, 'none', 'زر الشراء يختفي تماماً على الويب');
    assert.notEqual(r.noteDisplay, 'none', 'ملاحظة الدفع عبر Apple تظهر');
    assert.equal(r.errDisplay, 'none', 'لا رسالة خطأ — لم تُحاول أي عملية جلب');
    assert.equal(r.monthlyPrice, '', 'لا يُعرض أي سعر على الويب');
    assert.equal(r.annualPrice, '', 'لا يُعرض أي سعر على الويب');
  });
  console.log('  ✓ الويب بلا Capacitor: الزر مخفي، ملاحظة الدفع تظهر، بلا أسعار');
});

tests.push(async function boot_race_condition_rc_not_ready_before_paywall() {
  // يحاكي جهازاً حقيقياً: initRevenueCat() (وبداخله RC.configure()) يبدأ عند
  // الإقلاع بلا await، والمستخدم يفتح شاشة الاشتراك بسرعة قبل أن يخلص —
  // configure() يأخذ 900ms هنا (شبكة + Keychain على جهاز حقيقي). إذا لم
  // تنتظر fetchPackages اكتمال rcReady() قبل getOfferings، سترمي RevenueCat
  // "There is no singleton instance" وتعلق الشاشة على disabled للأبد.
  await withPage(async (page) => {
    const offerings = offeringsWith({
      monthly: product({ priceString: '$3.99', price: 3.99, currencyCode: 'USD' }),
      annual: product({ priceString: '$29.99', price: 29.99, currencyCode: 'USD' }),
    });
    await page.addInitScript(installCapacitorStub, {
      authUid: 'test-uid-race',
      rcApiKey: 'appl_TESTKEY',
      offeringsResult: offerings,
      configureDelayMs: 900,
    });
    await page.goto(FILE_URL);
    // bootAuth() الطبيعي عند تحميل الصفحة يستدعي initRevenueCat() بلا await
    // بالفعل (نفس مسار الجهاز الحقيقي). نفتح الـ paywall فوراً فوق هذا —
    // قبل ما يخلص RC.configure() بكثير — لإعادة إنتاج السباق كما يحصل فعلياً.
    await page.evaluate(() => window.go('s-paywall'));
    // ننتظر أطول من زمن configure() (900ms) حتى نتأكد إن الشاشة تعافت
    // ولم تعلق على حالة الفشل المبكر — لا استقرار مبكر على أول حالة نشوفها
    await page.waitForTimeout(4000);
    const r = await readPaywall(page);
    assert.equal(r.btnDisabled, false, `الزر ما زال disabled بعد اكتمال configure() — سباق تهيئة: ${JSON.stringify(r)}`);
    assert.equal(r.monthlyPrice, '$3.99');
    assert.equal(r.annualPrice, '$29.99');
    assert.equal(r.errDisplay, 'none', 'لا رسالة خطأ بعد نجاح الجلب');
  });
  console.log('  ✓ سباق تهيئة RC عند الإقلاع: الأسعار تظهر والزر يتفعّل بعد اكتمال configure()، لا يعلق على disabled');
});

tests.push(async function cancelled_purchase_is_idempotent_and_recovers_ui() {
  await withPage(async (page) => {
    const offerings = offeringsWith({
      monthly: product({ priceString: '$3.99', price: 3.99, currencyCode: 'USD' }),
    });
    await gotoPaywall(page, offerings, null, {
      purchaseError: { code: 'PURCHASE_CANCELLED', message: 'user cancelled' },
    });
    await page.evaluate(() => { window.startCheckout(); window.startCheckout(); });
    await page.waitForTimeout(100);
    const result = await page.evaluate(() => ({
      calls: window.__rcTest.purchaseCalls,
      button: getComputedStyle(document.getElementById('paywall-btn')).display,
      loading: getComputedStyle(document.getElementById('paywall-loading')).display,
    }));
    assert.equal(result.calls, 1, 'النقر المتزامن يجب ألا يرسل الإيصال مرتين');
    assert.notEqual(result.button, 'none', 'زر الشراء يعود بعد الإلغاء');
    assert.equal(result.loading, 'none', 'مؤشر الدفع يختفي بعد الإلغاء');
  });
  console.log('  ✓ إلغاء StoreKit: لا إرسال مكرر وتعود واجهة الشراء فوراً');
});

tests.push(async function restore_purchases_checks_server_and_routes_home() {
  await withPage(async (page) => {
    const offerings = offeringsWith({
      monthly: product({ priceString: '$3.99', price: 3.99, currencyCode: 'USD' }),
    });
    await page.addInitScript(installCapacitorStub, {
      authUid: 'test-uid-restore',
      rcApiKey: 'appl_TESTKEY',
      offeringsResult: offerings,
      configureDelayMs: 0,
    });
    let statusRequests = 0;
    await page.route(/\/api\/subscription\/status/, route => {
      statusRequests++;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"active":true}' });
    });
    await page.goto(FILE_URL);
    await page.waitForFunction(() => !!window._currentUid, null, { timeout: 8000 });
    await page.evaluate(() => window.rcRestore());
    await page.waitForFunction(() => document.getElementById('s-home').classList.contains('active'), null, { timeout: 8000 });
    assert.equal(await page.evaluate(() => window.__rcTest.restoreCalls), 1);
    assert.ok(statusRequests >= 1, 'يجب التحقق من الخادم بعد الاستعادة');
  });
  console.log('  ✓ استعادة StoreKit: استدعاء واحد ثم تحقق الخادم وفتح المحتوى');
});

let failed = 0;
for (const test of tests) {
  try {
    await test();
  } catch (e) {
    failed++;
    console.error(`  ✗ ${test.name}:`, e.message);
  }
}
console.log(`\nالنتيجة: ${tests.length - failed} نجح / ${failed} فشل`);
if (failed > 0) process.exit(1);
