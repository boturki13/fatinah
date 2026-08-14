import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = `file://${path.join(root, 'www/index.html')}`;

function installAuthHarness() {
  localStorage.setItem('fatinah_authProvider', JSON.stringify('firebase'));
  localStorage.setItem('fatinah_authUid', JSON.stringify('auth-user'));
  localStorage.setItem('fatinah_onbDone', JSON.stringify(true));
  window.__authCalls = { apple: 0, google: 0, phoneStart: 0, phoneConfirm: 0 };
  const listeners = {};
  const user = { uid: 'auth-user', displayName: 'لاعب اختبار', email: 'test@example.invalid', isAnonymous: false, providerData: [] };
  const ok = () => Promise.resolve({});
  window.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      FirebaseAuthentication: {
        getCurrentUser: () => Promise.resolve({ user }),
        getIdToken: () => Promise.resolve({ token: 'auth-token' }),
        signInWithApple: () => { window.__authCalls.apple++; return Promise.resolve({ user }); },
        signInWithGoogle: () => { window.__authCalls.google++; return Promise.resolve({ user }); },
        addListener: (name, callback) => { listeners[name] = callback; return Promise.resolve({ remove: ok }); },
        linkWithPhoneNumber: () => {
          window.__authCalls.phoneStart++;
          queueMicrotask(() => listeners.phoneCodeSent?.({ verificationId: 'verification-test' }));
          return Promise.resolve();
        },
        confirmVerificationCode: () => {
          window.__authCalls.phoneConfirm++;
          return Promise.resolve({ user: { ...user, phoneNumber: '+96550000000' } });
        },
      },
      RevenueCatKeyStore: { get: () => Promise.resolve({ value: '' }), set: ok, clear: ok },
      FirebaseCrashlytics: { setEnabled: ok, recordException: ok, setUserId: ok },
      SplashScreen: { hide: ok }, Preferences: { remove: ok },
    },
  };
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(installAuthHarness);
  await page.route('**/*', route => {
    if (route.request().url().startsWith('file://')) return route.continue();
    if (route.request().url().includes('/api/subscription/status')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"active":true}' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(url);
  await page.locator('#s-home.active').waitFor({ state: 'visible', timeout: 8000 });

  await page.evaluate(() => window.go('s-auth'));
  await page.waitForTimeout(450);
  await page.getByRole('button', { name: 'متابعة مع Apple' }).click({ force: true });
  await page.waitForFunction(() => window.__authCalls.apple === 1);

  await page.evaluate(() => window.go('s-auth'));
  await page.waitForTimeout(450);
  await page.getByRole('button', { name: 'متابعة مع Google' }).click({ force: true });
  await page.waitForFunction(() => window.__authCalls.google === 1);
  await page.locator('#s-home.active').waitFor({ state: 'visible', timeout: 8000 });

  await page.evaluate(() => window.openAccountSettings());
  await page.locator('#s-account.active').waitFor({ state: 'visible' });
  await page.locator('#verification-phone').fill('+96550000000');
  await page.locator('#send-phone-code-btn').click();
  await page.locator('#phone-code-form').waitFor({ state: 'visible' });
  await page.locator('#verification-phone-code').fill('123456');
  await page.locator('#confirm-phone-code-btn').click();
  await page.waitForFunction(() => window.__authCalls.phoneConfirm === 1);

  assert.deepEqual(await page.evaluate(() => window.__authCalls), {
    apple: 1, google: 1, phoneStart: 1, phoneConfirm: 1,
  });
  console.log('✓ مسارات Apple وGoogle والهاتف تستدعي إضافات iOS وتكمل النجاح مرة واحدة');
} finally {
  await browser.close();
}
