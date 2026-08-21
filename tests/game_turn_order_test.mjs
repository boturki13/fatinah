import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = `file://${path.join(root, 'www/index.html')}`;

function installNativeTestHarness() {
  localStorage.setItem('fatinah_authUid', JSON.stringify('turn-order-player'));
  localStorage.setItem('fatinah_onbDone', JSON.stringify(true));
  localStorage.setItem('fatinah_family', JSON.stringify([{
    name: 'أسئلة العائلة الاختبارية',
    questions: Array.from({ length: 6 }, (_, index) => ({
      q: `سؤال عائلي ${index + 1}`,
      answer: `إجابة ${index + 1}`,
    })),
  }]));
  const ok = () => Promise.resolve({});
  window.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      FirebaseAuthentication: {
        getCurrentUser: () => Promise.resolve({ user: { uid: 'turn-order-player', isAnonymous: true } }),
        getIdToken: () => Promise.resolve({ token: 'turn-order-token' }),
      },
      RevenueCatKeyStore: { get: () => Promise.resolve({ value: 'appl_TEST' }), set: ok, clear: ok },
      Purchases: { configure: ok, setAttributes: ok, setEmail: ok, setDisplayName: ok },
      FirebaseCrashlytics: { setEnabled: ok, recordException: ok, setUserId: ok },
      SplashScreen: { hide: ok },
      Preferences: { remove: ok },
      KeepAwake: { keepAwake: ok, allowSleep: ok },
    },
  };
}

async function createGame(browser, teamNames) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.addInitScript(installNativeTestHarness);
  await page.route('**/*', route => {
    const requestUrl = route.request().url();
    if (requestUrl.startsWith('file://')) return route.continue();
    if (requestUrl.includes('/api/subscription/status')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"active":true}' });
    }
    if (requestUrl.includes('/api/revenuecat/identity')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return route.abort();
  });
  await page.goto(url);
  await page.getByRole('button', { name: '🎯 يلا نلعب' }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '🎯 يلا نلعب' }).click();
  if (teamNames.length === 3) {
    await page.locator('#seg-teams button[data-n="3"]').click();
  }
  await page.locator('#seg-catcount button[data-n="2"]').click();
  for (let index = 0; index < teamNames.length; index++) {
    await page.locator(`#tn-${index}`).fill(teamNames[index]);
  }
  await page.getByRole('button', { name: 'الخطوة الياية: اختار الفئات' }).click();
  for (let index = 0; index < 2; index++) {
    await page.locator('.cat-pick:not(.on)').first().click();
  }
  await page.getByRole('button', { name: 'يلا نبدأ!' }).click();
  await page.locator('#s-board.active').waitFor({ state: 'visible' });
  return { context, page };
}

async function openQuestion(page) {
  await page.locator('#board .cell:not(.used)').first().click();
  await page.locator('#q-wrap.show').waitFor({ state: 'visible' });
}

async function revealAndResolve(page, teamName = null) {
  await page.getByRole('button', { name: '👁️ اكشف الإجابة' }).click();
  if (teamName) {
    await page.getByRole('button', { name: `✅ ${teamName}` }).click();
  } else {
    await page.getByRole('button', { name: '❌ محد جاوب صح' }).click();
  }
}

async function score(page, index) {
  return Number((await page.locator('.team-chip .cs').nth(index).textContent()).trim());
}

async function testTwoTeamAlternation(browser) {
  const names = ['اللاعب الأول', 'اللاعب الثاني'];
  const { context, page } = await createGame(browser, names);
  try {
    for (let question = 0; question < 6; question++) {
      const expected = names[question % names.length];
      assert.match(await page.locator('#turn-pill').textContent(), new RegExp(expected));
      await openQuestion(page);
      assert.match(await page.locator('#phase-pill').textContent(), new RegExp(expected));
      if (question === 0) {
        assert.equal(await page.locator('.timer-bar').count(), 0, 'لا يظهر شريط زمني');
        assert.match(await page.locator('#timer-num').textContent(), /^\d+$/, 'العداد رقمي فقط');
        assert.match(
          await page.locator('#countdown-timer').getAttribute('aria-label'),
          /^باقي \d+ ثانية$/,
          'العداد يعلن الوقت المتبقي لقارئ الشاشة',
        );
        const palettes = await page.locator('.ll').evaluateAll(buttons =>
          buttons.map(button => getComputedStyle(button).backgroundImage),
        );
        assert.equal(palettes.length, 4, 'تظهر وسائل المساعدة الأربع');
        assert.equal(new Set(palettes).size, 4, 'كل وسيلة مساعدة لها لون مستقل');
        assert.equal(
          await page.locator('#timer-hourglass').evaluate(element => element.classList.contains('is-flipped')),
          false,
        );
        await page.waitForTimeout(2100);
        assert.equal(
          await page.locator('#timer-hourglass').evaluate(element => element.classList.contains('is-flipped')),
          true,
          'الساعة الرملية تنقلب بعد ثانيتين',
        );
      }
      const owner = await page.evaluate(() => state.cur.owner);
      assert.equal(owner, question % names.length, `مالك السؤال ${question + 1}`);
      assert.equal(await page.locator('#turn-pill').getAttribute('role'), 'status');
      assert.equal(
        await page.locator('.team-chip').nth(question % names.length).getAttribute('aria-current'),
        'true',
      );
      await revealAndResolve(page, question % 2 === 0 ? expected : null);
    }
    assert.equal(await score(page, 0), 600, 'اللاعب الأول يجيب الأسئلة 1 و3 و5 فقط');
    assert.equal(await score(page, 1), 0, 'اللاعب الثاني لم يُمنح نقاطاً بلا إجابة صحيحة');
  } finally {
    await context.close();
  }
}

async function testThreeTeamAlternationAndTimerRace(browser) {
  const names = ['اللاعب الأول', 'اللاعب الثاني', 'اللاعب الثالث'];
  const { context, page } = await createGame(browser, names);
  try {
    for (let question = 0; question < 6; question++) {
      const expected = names[question % names.length];
      assert.match(await page.locator('#turn-pill').textContent(), new RegExp(expected));
      await openQuestion(page);
      assert.equal(await page.evaluate(() => state.cur.owner), question % names.length);
      await revealAndResolve(page);
    }

    await openQuestion(page);
    const oldToken = await page.evaluate(() => state.cur.token);
    await page.getByRole('button', { name: /اطرح على اللاعب الثاني/ }).click();
    assert.match(await page.locator('#phase-pill').textContent(), /اللاعب الثاني/);
    await page.evaluate(token => timeUp(token), oldToken);
    assert.match(
      await page.locator('#phase-pill').textContent(),
      /اللاعب الثاني/,
      'مؤقت المرحلة القديمة لا يتخطى دور اللاعب الثاني',
    );
  } finally {
    await context.close();
  }
}

async function testLifelineOwnership(browser) {
  const names = ['اللاعب الأول', 'اللاعب الثاني'];

  {
    const { context, page } = await createGame(browser, names);
    try {
      await openQuestion(page);
      await page.getByRole('button', { name: 'مضاعفة السؤال — فريق اللاعب الأول' }).click();
      await page.getByRole('button', { name: /اطرح على اللاعب الثاني/ }).click();
      await revealAndResolve(page, 'اللاعب الثاني');
      assert.equal(await score(page, 1), 100, 'مضاعفة اللاعب الأول لا تنتقل للاعب الثاني');
    } finally {
      await context.close();
    }
  }

  {
    const { context, page } = await createGame(browser, names);
    try {
      await openQuestion(page);
      await page.getByRole('button', { name: 'بحث بالجوال — فريق اللاعب الأول' }).click();
      assert.equal(
        await page.locator('#q-flow button:not([disabled])').count(),
        0,
        'لا يمكن نقل السؤال أثناء دقيقة البحث',
      );
      assert.equal(await page.evaluate(() => state.paused), true);
      await page.evaluate(() => {
        clearInterval(state.searchTimer);
        state.cur.searching = false;
        state.paused = false;
        advanceSteal(state.cur.token);
      });
      await revealAndResolve(page, 'اللاعب الثاني');
      assert.equal(await score(page, 1), 100, 'نصف نقاط البحث لا ينتقل للاعب الثاني');
    } finally {
      await context.close();
    }
  }
}

async function testPassAndTimeoutEligibility(browser) {
  {
    const names = ['اللاعب الأول', 'اللاعب الثاني'];
    const { context, page } = await createGame(browser, names);
    try {
      await openQuestion(page);
      await page.getByRole('button', { name: 'مرّرها للخصم — فريق اللاعب الأول' }).click();
      assert.match(await page.locator('#phase-pill').textContent(), /اللاعب الثاني/);
      assert.equal(
        await page.getByRole('button', { name: 'تغيير السؤال — فريق اللاعب الثاني' }).count(),
        1,
        'وسائل المساعدة تنتقل لصاحب مرحلة السرقة',
      );
      await page.getByRole('button', { name: '👁️ اكشف الإجابة' }).click();
      assert.deepEqual(await page.locator('.verdict-row .vb').allTextContents(), ['✅ اللاعب الثاني']);
      await page.getByRole('button', { name: '✅ اللاعب الثاني' }).click();
      assert.match(await page.locator('#turn-pill').textContent(), /اللاعب الثاني/);
    } finally {
      await context.close();
    }
  }

  {
    const names = ['اللاعب الأول', 'اللاعب الثاني', 'اللاعب الثالث'];
    const { context, page } = await createGame(browser, names);
    try {
      await openQuestion(page);
      await page.evaluate(() => timeUp(state.cur.token));
      assert.match(await page.locator('#phase-pill').textContent(), /اللاعب الثاني/);
      await page.evaluate(() => timeUp(state.cur.token));
      assert.match(await page.locator('#phase-pill').textContent(), /اللاعب الثالث/);
      await page.evaluate(() => timeUp(state.cur.token));
      assert.match(await page.locator('#phase-pill').textContent(), /منو جاوب صح/);
      assert.deepEqual(await page.locator('.verdict-row .vb').allTextContents(), [
        '✅ اللاعب الأول', '✅ اللاعب الثاني', '✅ اللاعب الثالث',
      ]);
      await page.evaluate(() => { awardTo(2); awardTo(2); });
      assert.equal(await score(page, 2), 100, 'حارس الحسم يمنع مضاعفة النقاط بالنقر المزدوج');
      assert.match(
        await page.locator('#turn-pill').textContent(),
        /اللاعب الثاني/,
        'الدور التالي يتبع مالك الخانة لا الفريق الذي فاز بالسرقة',
      );
    } finally {
      await context.close();
    }
  }
}

async function testSkipResetsQuestionEligibility(browser) {
  const names = ['اللاعب الأول', 'اللاعب الثاني', 'اللاعب الثالث'];
  const { context, page } = await createGame(browser, names);
  try {
    await openQuestion(page);
    await page.getByRole('button', { name: /اطرح على اللاعب الثاني/ }).click();
    await page.getByRole('button', { name: 'تغيير السؤال — فريق اللاعب الثاني' }).click();
    await page.getByRole('button', { name: '👁️ اكشف الإجابة' }).click();
    const eligible = await page.locator('.verdict-row .vb').allTextContents();
    assert.deepEqual(eligible, ['✅ اللاعب الثاني'], 'السؤال البديل لم يُطرح على اللاعب الأول');
  } finally {
    await context.close();
  }
}

async function testBombAndNewRoundReset(browser) {
  const names = ['اللاعب الأول', 'اللاعب الثاني'];
  const { context, page } = await createGame(browser, names);
  try {
    await page.evaluate(() => {
      state.teams[0].score = 1000;
      renderTeamsBar();
      updateBombButton();
    });
    await page.getByRole('button', { name: /قنبلة/ }).click();
    assert.match(await page.locator('#phase-pill').textContent(), /اللاعب الثاني/);
    await page.getByRole('button', { name: '👁️ اكشف الإجابة' }).click();
    await page.getByRole('button', { name: '✅ جاوب صح (+1200)' }).click();
    assert.equal(await score(page, 1), 1200);
    assert.match(await page.locator('#turn-pill').textContent(), /اللاعب الثاني/);

    await page.evaluate(() => restart());
    const reset = await page.evaluate(() => ({
      turn: state.turn,
      scores: state.teams.map(team => team.score),
      bombUsed: state.teams.map(team => team.bombUsed),
    }));
    assert.deepEqual(reset, {
      turn: 0,
      scores: [0, 0],
      bombUsed: [false, false],
    });
  } finally {
    await context.close();
  }
}

async function testFamilyRoundAlternation(browser) {
  const names = ['اللاعب الأول', 'اللاعب الثاني'];
  const { context, page } = await createGame(browser, names);
  try {
    await page.evaluate(() => go('s-home'));
    await page.getByRole('button', { name: '👨‍👩‍👧‍👦 أسئلة عائلية' }).click();
    await page.getByRole('button', { name: '▶ العب' }).click();
    assert.equal(await page.locator('#board .cell').count(), 6);
    assert.match(await page.locator('#turn-pill').textContent(), /النجوم/);
    await openQuestion(page);
    assert.match(await page.locator('#phase-pill').textContent(), /النجوم/);
    await revealAndResolve(page);
    assert.match(await page.locator('#turn-pill').textContent(), /الصقور/);
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch();
try {
  await testTwoTeamAlternation(browser);
  await testThreeTeamAlternationAndTimerRace(browser);
  await testLifelineOwnership(browser);
  await testPassAndTimeoutEligibility(browser);
  await testSkipResetsQuestionEligibility(browser);
  await testBombAndNewRoundReset(browser);
  await testFamilyRoundAlternation(browser);
  console.log('✓ ترتيب الأدوار: لاعبان وثلاثة، السرقة، المؤقت، الوسائل والقنبلة');
} finally {
  await browser.close();
}
