import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const databasePath = resolve(process.argv[2] || 'subscriptions.player-test.db');
const outputPath = resolve(process.argv[3] || 'output/player-test-harness.js');
const database = new DatabaseSync(databasePath, { readOnly: true });
const rows = database.prepare(`
  SELECT question_id, prompt, options_json, correct_index, level
  FROM editorial_questions
  WHERE status = 'approved'
  ORDER BY level, question_id
`).all();
database.close();

const questions = rows.map(row => ({
  questionId: String(row.question_id),
  question: String(row.prompt),
  options: JSON.parse(row.options_json),
  correctIndex: Number(row.correct_index),
  level: Number(row.level),
}));

if (questions.length !== 600) {
  throw new Error(`Player test bank must contain exactly 600 approved questions; found ${questions.length}`);
}
for (let level = 1; level <= 6; level += 1) {
  const count = questions.filter(question => question.level === level).length;
  if (count !== 100) throw new Error(`Level ${level} must contain 100 questions; found ${count}`);
}

const bankJson = JSON.stringify(questions).replaceAll('</script', '<\\/script');
const harness = `/* Generated player-test harness. Never include this file in a production build. */
(() => {
  'use strict';
  const BANK = ${bankJson};
  const activePacks = new Map();

  function randomIndex(max) {
    if (max <= 1) return 0;
    const limit = Math.floor(0x100000000 / max) * max;
    const value = new Uint32Array(1);
    do crypto.getRandomValues(value); while (value[0] >= limit);
    return value[0] % max;
  }
  function shuffle(values) {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const target = randomIndex(index + 1);
      [result[index], result[target]] = [result[target], result[index]];
    }
    return result;
  }
  function difficultySequence(count) {
    const base = Math.floor(count / 6);
    const remainder = count % 6;
    const result = [];
    for (let level = 1; level <= 6; level += 1) {
      for (let index = 0; index < base + (level <= remainder ? 1 : 0); index += 1) result.push(level);
    }
    return result;
  }
  function createPack(playerCount, questionsPerPlayer) {
    const pools = new Map();
    for (let level = 1; level <= 6; level += 1) {
      pools.set(level, shuffle(BANK.filter(question => question.level === level)));
    }
    const used = new Set();
    const take = (level, ownerIndex, ownerQuestionNumber, replacement = false) => {
      const pool = pools.get(level);
      let source = pool.pop();
      while (source && used.has(source.questionId)) source = pool.pop();
      if (!source) throw new Error('player_test_bank_exhausted');
      used.add(source.questionId);
      return {
        ...source,
        points: level * 100,
        ownerIndex,
        ownerQuestionNumber,
        replacement,
      };
    };
    const levels = difficultySequence(questionsPerPlayer);
    const questions = [];
    for (let questionNumber = 0; questionNumber < questionsPerPlayer; questionNumber += 1) {
      for (let ownerIndex = 0; ownerIndex < playerCount; ownerIndex += 1) {
        questions.push(take(levels[questionNumber], ownerIndex, questionNumber + 1));
      }
    }
    const replacements = {};
    for (let ownerIndex = 0; ownerIndex < playerCount; ownerIndex += 1) {
      for (let level = 1; level <= 6; level += 1) {
        replacements[\`\${ownerIndex}:\${level}\`] = take(level, ownerIndex, 0, true);
      }
    }
    const now = Date.now();
    const pack = {
      schemaVersion: 1,
      packId: \`PLAYER-TEST-\${now}-\${randomIndex(1_000_000)}\`,
      playerCount,
      questionsPerPlayer,
      timerSeconds: 30,
      questions,
      replacements,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 7 * 86_400_000).toISOString(),
    };
    activePacks.set(pack.packId, pack);
    return pack;
  }

  Object.defineProperty(window, '__FATINAH_GAME_FLOW_UI_TEST__', { value: true });
  Object.defineProperty(window, '__FATINAH_PLAYER_TEST_BUILD__', { value: true });
  localStorage.setItem('fatinah_authUid', JSON.stringify('player-test-device'));
  localStorage.setItem('fatinah_playerName', JSON.stringify('لاعب'));
  window.__FATINAH_GAME_API__ = async (route, payload = {}) => {
    if (route === 'packs/ensure') {
      const players = Math.max(1, Math.min(3, Number(payload.playerCount) || 1));
      const count = Math.max(10, Math.min(30, Number(payload.questionsPerPlayer) || 10));
      const target = Math.max(1, Math.min(2, Number(payload.target) || 1));
      return { packs: Array.from({ length: target }, () => createPack(players, count)), cachedAhead: target };
    }
    if (route === 'packs/start') return activePacks.get(payload.packId) || { ok: true };
    if (route === 'questions/report') {
      const key = 'fatinah_player_test_reports';
      const reports = JSON.parse(localStorage.getItem(key) || '[]');
      reports.push({ ...payload, createdAt: new Date().toISOString() });
      localStorage.setItem(key, JSON.stringify(reports.slice(-50)));
      return { ok: true, localTest: true };
    }
    return { ok: true, localTest: true };
  };
})();
`;

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, harness, 'utf8');
console.log(`Built ${outputPath} with ${questions.length} approved questions.`);
