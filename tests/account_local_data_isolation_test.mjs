import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = `file://${path.join(root, 'www/index.html')}`;

function installHarness() {
  localStorage.setItem('fatinah_authProvider', JSON.stringify('firebase'));
  localStorage.setItem('fatinah_authUid', JSON.stringify('account-a'));
  localStorage.setItem('fatinah_onbDone', JSON.stringify(true));
  // يحاكي بيانات إصدار قديم قبل عزلها حسب UID.
  localStorage.setItem('fatinah_stats', JSON.stringify({
    games: 7, correct: 4, totalQ: 8, bestScore: 900, wins: 2, ach: { first: true },
  }));
  localStorage.setItem('fatinah_family', JSON.stringify([{
    name: 'أسئلة خاصة بالحساب أ',
    questions: [{ q: 'سؤال خاص', o: ['أ', 'ب', 'ج', 'د'], a: 0 }],
  }]));

  const user = { uid: 'account-a', isAnonymous: false, providerData: [] };
  const ok = () => Promise.resolve({});
  window.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      FirebaseAuthentication: {
        getCurrentUser: () => Promise.resolve({ user }),
        getIdToken: () => Promise.resolve({ token: 'account-token' }),
      },
      RevenueCatKeyStore: { get: () => Promise.resolve({ value: '' }), set: ok, clear: ok },
      FatinahDeviceIntegrity: { generateDeviceCheckToken: () => Promise.resolve({ token: 'device-check-test-token' }) },
      FirebaseCrashlytics: { setEnabled: ok, recordException: ok, setUserId: ok },
      SplashScreen: { hide: ok },
      Preferences: { remove: ok },
    },
  };
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(installHarness);
  await page.route('**/*', route => {
    if (route.request().url().startsWith('file://')) return route.continue();
    if (route.request().url().includes('/api/v2/subscription/status')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"active":true}' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(url);
  await page.locator('#s-home.active').waitFor({ state: 'visible', timeout: 8000 });

  const migrated = await page.evaluate(() => ({
    stats: JSON.parse(localStorage.getItem('fatinah_stats_account-a')),
    family: JSON.parse(localStorage.getItem('fatinah_family_account-a')),
    owner: JSON.parse(localStorage.getItem('fatinah_legacy_account_data_owner')),
  }));
  assert.equal(migrated.stats.games, 7);
  assert.equal(migrated.family[0].name, 'أسئلة خاصة بالحساب أ');
  assert.equal(migrated.owner, 'account-a');

  const accountB = await page.evaluate(() => {
    window._currentUid = 'account-b';
    activateLocalAccount('account-b');
    return { stats: structuredClone(stats), family: structuredClone(familyCats) };
  });
  assert.equal(accountB.stats.games, 0, 'الحساب ب لا يرث إحصاءات الحساب أ');
  assert.deepEqual(accountB.family, [], 'الحساب ب لا يرى فئات الحساب أ العائلية');

  await page.evaluate(() => {
    stats.games = 2;
    familyCats = [{ name: 'فئة الحساب ب', questions: [] }];
    saveStats();
    saveFamily();
    window._currentUid = 'account-a';
    activateLocalAccount('account-a');
  });
  const restoredA = await page.evaluate(() => ({
    stats: structuredClone(stats), family: structuredClone(familyCats),
  }));
  assert.equal(restoredA.stats.games, 7);
  assert.equal(restoredA.family[0].name, 'أسئلة خاصة بالحساب أ');

  const storedB = await page.evaluate(() => ({
    stats: JSON.parse(localStorage.getItem('fatinah_stats_account-b')),
    family: JSON.parse(localStorage.getItem('fatinah_family_account-b')),
  }));
  assert.equal(storedB.stats.games, 2);
  assert.equal(storedB.family[0].name, 'فئة الحساب ب');

  console.log('✓ الإحصاءات والفئات العائلية معزولة لكل حساب مع ترحيل آمن للبيانات القديمة');
} finally {
  await browser.close();
}
