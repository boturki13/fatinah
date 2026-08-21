import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = `file://${path.join(root, 'www/index.html')}`;

const accountA = 'firebase-account-a';
const accountB = 'firebase-account-b';
const accountC = 'firebase-account-c';
const rcA = '11111111-1111-4111-8111-111111111111';
const rcB = '22222222-2222-4222-8222-222222222222';
const rcC = '33333333-3333-4333-8333-333333333333';

function installRevenueCatHarness({ accountA, rcA, rcB, rcC }) {
  localStorage.setItem('fatinah_authProvider', JSON.stringify('firebase'));
  localStorage.setItem('fatinah_authUid', JSON.stringify(accountA));
  localStorage.setItem('fatinah_onbDone', JSON.stringify(true));
  localStorage.setItem('fatinah_rcAppUserIds', JSON.stringify({
    [accountA]: rcA,
    'firebase-account-b': rcB,
    'firebase-account-c': rcC,
  }));

  window.__online = true;
  window.__rcCustomerMode = 'active';
  window.__firebaseUser = { uid: accountA, isAnonymous: false, providerData: [] };
  window.__rcCalls = { configure: [], logIn: [], logOut: 0, customerInfo: 0 };
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    get: () => window.__online,
  });

  const ok = () => Promise.resolve({});
  window.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      FirebaseAuthentication: {
        getCurrentUser: () => Promise.resolve({ user: window.__firebaseUser }),
        getIdToken: () => Promise.resolve({ token: `token-${window.__firebaseUser?.uid || 'none'}` }),
        signOut: () => { window.__firebaseUser = null; return Promise.resolve(); },
      },
      RevenueCatKeyStore: {
        get: () => Promise.resolve({ value: 'appl_TESTKEY' }),
        set: ok,
        clear: ok,
      },
      Purchases: {
        configure: ({ appUserID }) => {
          window.__rcCalls.configure.push(appUserID);
          return Promise.resolve();
        },
        logIn: ({ appUserID }) => {
          window.__rcCalls.logIn.push(appUserID);
          return Promise.resolve({});
        },
        logOut: () => {
          window.__rcCalls.logOut++;
          return Promise.resolve({});
        },
        getCustomerInfo: () => {
          window.__rcCalls.customerInfo++;
          if(window.__rcCustomerMode === 'error') return Promise.reject(new Error('offline'));
          const active = window.__rcCustomerMode === 'active';
          return Promise.resolve({
            customerInfo: {
              entitlements: { active: active ? { premium: {} } : {} },
            },
          });
        },
      },
      FirebaseCrashlytics: { setEnabled: ok, recordException: ok, setUserId: ok },
      SplashScreen: { hide: ok },
      Preferences: {
        keys: () => Promise.resolve({ keys: [] }),
        get: () => Promise.resolve({ value: null }),
        set: ok,
        remove: ok,
      },
    },
  };
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(installRevenueCatHarness, { accountA, rcA, rcB, rcC });
  await page.route('**/*', route => {
    if(route.request().url().startsWith('file://')) return route.continue();
    if(route.request().url().includes('/api/v2/revenuecat/identity')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    if(route.request().url().includes('/api/v2/subscription/status')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"active":false}' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto(url);
  await page.locator('#s-home.active').waitFor({ state: 'visible', timeout: 8000 });
  assert.equal(await page.evaluate(() => rcIsActive()), true);

  const cacheA = await page.evaluate(() => JSON.parse(localStorage.getItem('fatinah_rcSubCache')));
  assert.deepEqual(
    { uid: cacheA.uid, rcAppUserId: cacheA.rcAppUserId, active: cacheA.active },
    { uid: accountA, rcAppUserId: rcA, active: true },
    'يجب ربط كاش الاشتراك بالحساب أ وهويته المؤكدة داخل RevenueCat',
  );

  await page.evaluate(async () => {
    window.confirm = () => true;
    await signOut();
  });
  const afterSignOut = await page.evaluate(() => ({
    cache: localStorage.getItem('fatinah_rcSubCache'),
    active: _hasActiveSubscription,
    resolved: _subscriptionResolved,
    rcCurrent: RC_CURRENT_APP_USER_ID,
    logOutCalls: window.__rcCalls.logOut,
  }));
  assert.equal(afterSignOut.cache, null, 'تسجيل الخروج يجب أن يمسح كاش الاشتراك');
  assert.equal(afterSignOut.active, false, 'تسجيل الخروج يجب أن يسحب صلاحية الاشتراك من الذاكرة فوراً');
  assert.equal(afterSignOut.resolved, false, 'الحساب التالي يحتاج فحص اشتراك جديداً');
  assert.equal(afterSignOut.rcCurrent, '');
  assert.equal(afterSignOut.logOutCalls, 1);

  // سجّل دخول الحساب ب واربط هويته أولاً، ثم حاكي انقطاع الشبكة. حتى لو أعاد
  // إصدار قديم كاش الحساب أ إلى القرص، لا يجوز أن يرثه الحساب ب.
  await page.evaluate(async ({ accountA, accountB, rcA }) => {
    window.__firebaseUser = { uid: accountB, isAnonymous: false, providerData: [] };
    storeSet('authUid', accountB);
    storeSet('authProvider', 'firebase');
    window._currentUid = accountB;
    clearIdTokenCache();
    await initRevenueCat();
    storeSet('rcSubCache', { uid: accountA, rcAppUserId: rcA, active: true, ts: Date.now() });
    window.__online = false;
    window.__rcCustomerMode = 'error';
  }, { accountA, accountB, rcA });

  const staleResult = await page.evaluate(() => rcIsActive());
  assert.notEqual(staleResult, true, 'الحساب ب غير المشترك لا يرث اشتراك الحساب أ أثناء عدم الاتصال');
  assert.equal(staleResult, null, 'الكاش المختلف في UID أو App User ID يُرفض بالكامل');

  // بعد معرفة أن ب غير مشترك، تُحفظ النتيجة بهويته هو، ويمكن استخدامها
  // أوفلاين من الحساب نفسه فقط.
  await page.evaluate(() => {
    window.__online = true;
    window.__rcCustomerMode = 'inactive';
  });
  assert.equal(await page.evaluate(() => rcIsActive()), false);
  await page.evaluate(() => {
    window.__online = false;
    window.__rcCustomerMode = 'error';
  });
  assert.equal(await page.evaluate(() => rcIsActive()), false);
  const cacheB = await page.evaluate(() => JSON.parse(localStorage.getItem('fatinah_rcSubCache')));
  assert.deepEqual(
    { uid: cacheB.uid, rcAppUserId: cacheB.rcAppUserId, active: cacheB.active },
    { uid: accountB, rcAppUserId: rcB, active: false },
  );

  // تبديل الهوية مباشرة (حتى من دون زر الخروج) يصفّر الكاش والصلاحية قبل
  // بدء فحص حساب ج.
  const immediateSwitch = await page.evaluate(({ accountC }) => {
    window.__online = true;
    window.__rcCustomerMode = 'inactive';
    window.__firebaseUser = { uid: accountC, isAnonymous: false, providerData: [] };
    window._authReturnScreen = 's-stats';
    afterAuthSuccess('الحساب ج', 'firebase', accountC, 'c@example.invalid');
    return {
      cache: localStorage.getItem('fatinah_rcSubCache'),
      active: _hasActiveSubscription,
      resolved: _subscriptionResolved,
      uid: window._currentUid,
      rcCurrent: RC_CURRENT_APP_USER_ID,
    };
  }, { accountC });
  assert.equal(immediateSwitch.cache, null);
  assert.equal(immediateSwitch.active, false);
  assert.equal(immediateSwitch.resolved, false);
  assert.equal(immediateSwitch.uid, accountC);
  assert.equal(immediateSwitch.rcCurrent, '');
  await page.waitForFunction(() => window.__rcCalls.logOut >= 2);

  console.log('✓ كاش RevenueCat معزول بهوية Firebase وApp User ID ويُمسح عند الخروج أو تبديل الحساب');
} finally {
  await browser.close();
}
