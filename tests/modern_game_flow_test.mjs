import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = `file://${path.join(root, 'www/index.html')}`;

function installModernGameHarness() {
  Object.defineProperty(window, '__FATINAH_GAME_FLOW_UI_TEST__', { value: true });
  localStorage.setItem('fatinah_authUid', JSON.stringify('modern-game-test'));
  localStorage.setItem('fatinah_playerName', JSON.stringify('أحمد'));
  const difficultySequence = count => {
    const base = Math.floor(count / 6), remainder = count % 6, result = [];
    for (let level = 1; level <= 6; level++) {
      for (let index = 0; index < base + (level <= remainder ? 1 : 0); index++) result.push(level);
    }
    return result;
  };
  const makeQuestion = (pack, index, replacement = false, owner = 0, level = 1, ownerQuestionNumber = 1) => ({
    questionId: `${pack}-Q-${replacement ? 'R-' : ''}${index}-${owner}-${level}`,
    question: replacement ? `سؤال بديل للمستوى ${level}` : `سؤال الجولة رقم ${index + 1}`,
    options: [`الإجابة الصحيحة ${index}`, `خيار خاطئ أ ${index}`, `خيار خاطئ ب ${index}`, `خيار خاطئ ج ${index}`],
    correctIndex: 0, level, points: level * 100, ownerIndex: owner,
    ownerQuestionNumber: replacement ? 0 : ownerQuestionNumber,
    replacement,
  });
  const makePack = (name, playerCount, questionsPerPlayer) => {
    const levels = difficultySequence(questionsPerPlayer);
    const questions = [];
    let index = 0;
    for (let questionNumber = 0; questionNumber < questionsPerPlayer; questionNumber++) {
      for (let owner = 0; owner < playerCount; owner++) {
        questions.push(makeQuestion(name, index++, false, owner, levels[questionNumber], questionNumber + 1));
      }
    }
    const replacements = {};
    for (let owner = 0; owner < playerCount; owner++) {
      for (let level = 1; level <= 6; level++) replacements[`${owner}:${level}`] = makeQuestion(name, 100 + level, true, owner, level);
    }
    return { schemaVersion: 1, packId: name, playerCount, questionsPerPlayer, timerSeconds: 30, questions, replacements, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  };
  const packs = new Map();
  window.__gameApiCalls = [];
  window.__FATINAH_GAME_API__ = async (route, payload) => {
    window.__gameApiCalls.push({ route, payload });
    if (route === 'packs/ensure') {
      const target = Math.max(1, Math.min(2, Number(payload.target) || 1));
      const created = Array.from({ length: target }, (_, index) =>
        makePack(`PACK-${payload.playerCount}-${payload.questionsPerPlayer}-${index}`, payload.playerCount, payload.questionsPerPlayer));
      created.forEach(pack => packs.set(pack.packId, pack));
      return { packs: created, cachedAhead: target };
    }
    if (route === 'packs/start') return packs.get(payload.packId);
    return { ok: true };
  };
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(installModernGameHarness);
  await page.route('**/*', route => route.request().url().startsWith('file://') ? route.continue() : route.abort());
  await page.goto(url);
  await page.waitForFunction(() => document.body.dataset.gameFlowUiTest === 'ready');
  await page.getByRole('button', { name: '🎯 يلا نلعب' }).click();
  await page.locator('#s-teams.active').waitFor({ state: 'visible' });
  await page.locator('#modern-player-0').fill('أحمد');
  await page.locator('#modern-player-1').fill('خالد');
  await page.locator('#modern-start-btn').click();
  await page.locator('#s-modern-game.active').waitFor({ state: 'visible' });

  // أحمد يجيب بشكل صحيح، لكن الحل يبقى مخفياً حتى يجيب خالد.
  await page.locator('[data-action="modern-answer"][data-option-index="0"]').click();
  assert.equal(await page.locator('[data-option-index="0"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('[data-option-index="0"]').evaluate(element => element.classList.contains('locked-choice')), true);
  assert.equal(await page.locator('.modern-option:disabled').count(), 4);
  assert.equal(await page.evaluate(() => window.FatinahModernGame.state.phase), 'locked');
  await page.waitForTimeout(180);
  const lockedVisual = await page.locator('[data-option-index="0"]').evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundImage, border: style.borderColor, opacity: style.opacity };
  });
  assert.match(lockedVisual.background, /rgb\(18, 63, 120\).*rgb\(8, 43, 87\)/);
  assert.equal(lockedVisual.border, 'rgb(77, 157, 255)');
  assert.equal(lockedVisual.opacity, '1');
  await page.locator('[data-option-index="0"]').evaluate(element => element.click());
  assert.equal(await page.evaluate(() => window.FatinahModernGame.state.answers.length), 1);
  assert.equal(await page.locator('#modern-reveal').isHidden(), true);
  await page.waitForFunction(() => document.querySelector('#modern-answering-pill')?.textContent.includes('خالد'));
  assert.equal(await page.locator('#modern-reveal').isHidden(), true);
  assert.equal(await page.locator('.modern-option.locked-choice').count(), 0);
  await page.locator('[data-action="modern-answer"][data-option-index="1"]').click();
  assert.equal(await page.locator('[data-option-index="1"]').evaluate(element => element.classList.contains('locked-choice')), true);
  await page.locator('#modern-reveal').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.modern-option.locked-choice').count(), 0);
  assert.equal(await page.locator('.modern-option.correct').count(), 1);
  assert.equal(await page.locator('.modern-option.wrong').count(), 1);
  await page.waitForTimeout(180);
  const revealVisuals = await page.evaluate(() => {
    const read = selector => {
      const style = getComputedStyle(document.querySelector(selector));
      return { background: style.backgroundImage, border: style.borderColor, opacity: style.opacity };
    };
    return { correct: read('.modern-option.correct'), wrong: read('.modern-option.wrong') };
  });
  assert.match(revealVisuals.correct.background, /rgb\(23, 107, 76\).*rgb\(14, 73, 54\)/);
  assert.equal(revealVisuals.correct.border, 'rgb(66, 230, 170)');
  assert.match(revealVisuals.wrong.background, /rgb\(124, 30, 52\).*rgb\(79, 20, 37\)/);
  assert.equal(revealVisuals.wrong.border, 'rgb(255, 92, 122)');
  assert.equal(revealVisuals.wrong.opacity, '1');
  let snapshot = await page.evaluate(() => ({
    scores: window.FatinahModernGame.state.players.map(player => player.score),
    answerCount: window.FatinahModernGame.state.answers.length,
  }));
  assert.deepEqual(snapshot, { scores: [100, 0], answerCount: 2 });

  // سؤال خالد: يستخدم الدبل ويخطئ، فيُخصم منه 200، ثم يفوز أحمد بالقيمة الأصلية 100.
  await page.locator('#modern-next-btn').click();
  await page.locator('[data-lifeline="double"]').click();
  await page.locator('[data-action="modern-answer"][data-option-index="1"]').click();
  await page.waitForFunction(() => document.querySelector('#modern-answering-pill')?.textContent.includes('أحمد'));
  await page.locator('[data-action="modern-answer"][data-option-index="0"]').click();
  await page.locator('#modern-reveal').waitFor({ state: 'visible' });
  snapshot = await page.evaluate(() => window.FatinahModernGame.state.players.map(player => player.score));
  assert.deepEqual(snapshot, [200, -200]);

  // وسيلة الحذف لصاحب السؤال تزيل خيارين خاطئين بالضبط.
  await page.locator('#modern-next-btn').click();
  await page.locator('[data-lifeline="eliminate"]').click();
  assert.equal(await page.locator('.modern-option.eliminated').count(), 2);
  assert.equal(await page.locator('.modern-option.correct.eliminated').count(), 0);
  const eliminatedBeforeAnswer = await page.locator('.modern-option.eliminated').evaluateAll(elements => elements.map(element => element.dataset.optionIndex));
  await page.locator('[data-action="modern-answer"][data-option-index="0"]').click();
  await page.waitForFunction(() => document.querySelector('#modern-answering-pill')?.textContent.includes('خالد'));
  assert.deepEqual(
    await page.locator('.modern-option.eliminated').evaluateAll(elements => elements.map(element => element.dataset.optionIndex)),
    eliminatedBeforeAnswer,
  );
  assert.equal(await page.locator('.modern-option.eliminated').count(), 2);

  assert.deepEqual(
    await page.evaluate(() => window.FatinahModernGame.difficultySequence(10)),
    [1, 1, 2, 2, 3, 3, 4, 4, 5, 6],
  );

  // ثلاثة لاعبين: الاختيار الأزرق خاص باللاعب الحالي، والحذف يبقى حتى آخر لاعب.
  const pageThree = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await pageThree.addInitScript(installModernGameHarness);
  await pageThree.route('**/*', route => route.request().url().startsWith('file://') ? route.continue() : route.abort());
  await pageThree.goto(url);
  await pageThree.waitForFunction(() => document.body.dataset.gameFlowUiTest === 'ready');
  await pageThree.getByRole('button', { name: '🎯 يلا نلعب' }).click();
  await pageThree.locator('[data-action="set-modern-player-count"][data-n="3"]').click();
  for (const [index, name] of ['أحمد', 'خالد', 'سالم'].entries()) await pageThree.locator(`#modern-player-${index}`).fill(name);
  await pageThree.locator('#modern-start-btn').click();
  await pageThree.locator('#s-modern-game.active').waitFor({ state: 'visible' });
  await pageThree.locator('[data-lifeline="eliminate"]').click();
  const eliminatedForAll = await pageThree.locator('.modern-option.eliminated').evaluateAll(elements => elements.map(element => element.dataset.optionIndex));
  assert.equal(eliminatedForAll.length, 2);

  await pageThree.locator('[data-option-index="0"]').click();
  assert.equal(await pageThree.locator('[data-option-index="0"]').evaluate(element => element.classList.contains('locked-choice')), true);
  await pageThree.waitForFunction(() => document.querySelector('#modern-answering-pill')?.textContent.includes('خالد'));
  assert.equal(await pageThree.locator('.modern-option.locked-choice').count(), 0);
  assert.deepEqual(await pageThree.locator('.modern-option.eliminated').evaluateAll(elements => elements.map(element => element.dataset.optionIndex)), eliminatedForAll);

  const remainingWrong = await pageThree.locator('.modern-option:not(.eliminated)').evaluateAll(elements =>
    elements.map(element => Number(element.dataset.optionIndex)).find(index => index !== 0));
  await pageThree.locator(`[data-option-index="${remainingWrong}"]`).click();
  assert.equal(await pageThree.locator(`[data-option-index="${remainingWrong}"]`).evaluate(element => element.classList.contains('locked-choice')), true);
  await pageThree.waitForFunction(() => document.querySelector('#modern-answering-pill')?.textContent.includes('سالم'));
  assert.equal(await pageThree.locator('.modern-option.locked-choice').count(), 0);
  assert.deepEqual(await pageThree.locator('.modern-option.eliminated').evaluateAll(elements => elements.map(element => element.dataset.optionIndex)), eliminatedForAll);

  await pageThree.locator('[data-option-index="0"]').click();
  assert.equal(await pageThree.locator('[data-option-index="0"]').evaluate(element => element.classList.contains('locked-choice')), true);
  await pageThree.locator('#modern-reveal').waitFor({ state: 'visible' });
  assert.equal(await pageThree.locator('.modern-option.correct').count(), 1);
  assert.equal(await pageThree.locator('.modern-option.wrong').count(), 1);
  assert.equal(await pageThree.evaluate(() => window.FatinahModernGame.state.answers.length), 3);
  console.log('✓ الإجابات مخفية حتى الآخر، والأولوية والدبل والحذف تعمل كما هو متفق');
} finally {
  await browser.close();
}
