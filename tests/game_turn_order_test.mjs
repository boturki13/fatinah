import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {testCatalog,testRound,testReveal} from './fixtures/question-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = `file://${path.join(root, 'www/index.html')}`;

function installNativeTestHarness() {
  window.__FATINAH_LEGACY_SPOKEN_TEST__ = true;
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
      FatinahDeviceIntegrity: { generateDeviceCheckToken: () => Promise.resolve({ token: 'device-check-test-token' }) },
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
    if (requestUrl.includes('/api/v2/subscription/status')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"active":true}' });
    }
    if (requestUrl.includes('/api/v2/revenuecat/identity')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"rcAppUserId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}' });
    }
    if (requestUrl.includes('/api/v2/questions/seen')) {
      const body = route.request().method() === 'GET' ? '{"items":[]}' : '{"ok":true}';
      return route.fulfill({ status: 200, contentType: 'application/json', body });
    }
    if(requestUrl.includes('/api/v2/questions/reservations/release')){
      return route.fulfill({status:200,contentType:'application/json',body:'{"ok":true,"released":12}'});
    }
    if(requestUrl.includes('/api/v2/questions/catalog')){
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(testCatalog())});
    }
    if(requestUrl.includes('/api/v2/questions/round')){
      const request=JSON.parse(route.request().postData()||'{}');
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(testRound(request.categories||[]))});
    }
    if(requestUrl.includes('/api/v2/questions/reveal')){
      const request=JSON.parse(route.request().postData()||'{}');
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(testReveal(request.questionId))});
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
  while (await page.getByRole('button', { name: /^⏭️ اطرح على/ }).count()) {
    await page.getByRole('button', { name: /^⏭️ اطرح على/ }).click();
  }
  await page.getByRole('button', { name: '👁️ اكشف الإجابة' }).click();
  await page.locator('#answer-box.show').waitFor({state:'visible'});
  if (teamName) {
    await page.getByRole('button', { name: `✅ ${teamName}` }).click();
  } else {
    await page.getByRole('button', { name: '❌ محد جاوب صح' }).click();
  }
}

async function revealAfterAllTeams(page) {
  while (await page.getByRole('button', { name: /^⏭️ اطرح على/ }).count()) {
    await page.getByRole('button', { name: /^⏭️ اطرح على/ }).click();
  }
  await page.getByRole('button', { name: '👁️ اكشف الإجابة' }).click();
  await page.locator('#answer-box.show').waitFor({state:'visible'});
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
        assert.deepEqual(
          await page.locator('.ll .lli').allTextContents(),
          ['🔍', '⚔️', '🔄', '✖️2'],
          'تبقى رموز وسائل المساعدة المعتمدة ثابتة',
        );
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
      assert.match(await page.locator('#search-timer-label').textContent(),/45/,'مهلة البحث تبدأ من 45 ثانية.');
      const finishSearch=page.getByRole('button',{name:'حصلنا الإجابة، وقف البحث وكمّل السؤال'});
      assert.equal(await finishSearch.isEnabled(),true,'يقدر اللاعب ينهي البحث قبل انتهاء المهلة.');
      const finishRect=await finishSearch.boundingBox();
      assert.ok(finishRect&&finishRect.width>=44&&finishRect.height>=44,`زر إنهاء البحث يحافظ على هدف لمس 44×44: ${JSON.stringify(finishRect)}`);
      assert.equal(
        await page.locator('#q-flow button:not([disabled])').count(),
        0,
        'لا يمكن نقل السؤال أثناء مهلة البحث',
      );
      assert.equal(
        await page.locator('#lifelines .ll:not([disabled])').count(),
        0,
        'كل وسائل المساعدة تتعطل أثناء مهلة البحث',
      );
      assert.equal(await page.evaluate(() => state.paused), true);
      const blockedLifeline=await page.evaluate(()=>{
        const before={phase:state.cur.phase,remaining:state.teams[0].ll,used:[...state.teams[0].used]};
        const result=useLifeline('pass',0);
        return {
          before,result,
          after:{phase:state.cur.phase,remaining:state.teams[0].ll,used:[...state.teams[0].used]},
          searching:state.cur.searching,
        };
      });
      assert.equal(blockedLifeline.result,false,'الحارس المنطقي يرفض الوسيلة حتى لو استُدعيت مباشرة.');
      assert.deepEqual(blockedLifeline.after,blockedLifeline.before,'محاولة الوسيلة أثناء البحث لا تغيّر المرحلة أو الرصيد.');
      assert.equal(blockedLifeline.searching,true,'مؤقت البحث يبقى في حالته الصحيحة بعد المحاولة المرفوضة.');
      await finishSearch.click();
      const finishedEarly=await page.evaluate(()=>({
        searching:state.cur.searching,paused:state.paused,searchTimeLeft:state.searchTimeLeft,
        flowEnabled:[...document.querySelectorAll('#q-flow button')].some(button=>!button.disabled),
      }));
      assert.deepEqual(finishedEarly,{searching:false,paused:false,searchTimeLeft:0,flowEnabled:true},'إنهاء البحث المبكر يرجع السؤال والعداد والأزرار فوراً.');
      await page.evaluate(() => {
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
      await revealAfterAllTeams(page);
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
      await page.locator('#answer-box.show').waitFor({state:'visible'});
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
    // جولة الخادم توفر سؤالين في كل مستوى؛ تغيير السؤال لا يجوز أن
    // يستعين بمستوى آخر.
    await openQuestion(page);
    const originalQuestion=await page.evaluate(() => ({id:state.cur.q.id,d:state.cur.q.d}));
    await page.getByRole('button', { name: /اطرح على اللاعب الثاني/ }).click();
    await page.getByRole('button', { name: 'تغيير السؤال — فريق اللاعب الثاني' }).click();
    const replacementQuestion=await page.evaluate(() => ({id:state.cur.q.id,d:state.cur.q.d}));
    assert.notEqual(replacementQuestion.id, originalQuestion.id, 'تغيير السؤال يحتاج بديلاً جديداً.');
    assert.equal(replacementQuestion.d, originalQuestion.d, 'السؤال البديل يجب أن يبقى في مستوى صف اللوحة نفسه.');
    await revealAfterAllTeams(page);
    const eligible = await page.locator('.verdict-row .vb').allTextContents();
    assert.deepEqual(eligible, ['✅ اللاعب الثاني', '✅ اللاعب الثالث'], 'السؤال البديل يمر على بقية الفرق بالترتيب دون اللاعب الأول');
  } finally {
    await context.close();
  }
}

async function testBombDisabledAndNewRoundReset(browser) {
  const names = ['اللاعب الأول', 'اللاعب الثاني'];
  const { context, page } = await createGame(browser, names);
  try {
    await page.evaluate(() => {
      state.teams[0].score = 1000;
      renderTeamsBar();
      updateBombButton();
    });
    assert.equal(await page.locator('#bomb-box.show').count(), 0,
      'القنبلة مخفية في إصدار الخيارات الأربعة');
    assert.deepEqual(await page.evaluate(async() => ({
      startResult: startBomb(),
      fireResult: await fireBomb(1),
      currentQuestion: state.cur,
      bombUsed: state.teams.map(team => team.bombUsed),
    })), {
      startResult: false,
      fireResult: false,
      currentQuestion: null,
      bombUsed: [false, false],
    }, 'حارس الدوال يمنع تشغيل المسار الشفهي مباشرة');

    await page.evaluate(() => {
      state.teams[0].bombUsed=true;
      restart();
    });
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
    assert.equal(await page.locator('#board .cell').count(), 12,
      'لا تبدأ جولة عائلية ثانية بينما الجولة الحالية نشطة');
    assert.equal(await page.evaluate(()=>state.familyRound),null);
    await page.evaluate(()=>{
      state.roundActive=false;
      clearActiveRound();
    });
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
  await testBombDisabledAndNewRoundReset(browser);
  await testFamilyRoundAlternation(browser);
  console.log('✓ ترتيب الأدوار: لاعبان وثلاثة، السرقة، المؤقت، الوسائل، وتعطيل القنبلة الشفهية');
} finally {
  await browser.close();
}
