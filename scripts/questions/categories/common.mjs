import crypto from 'node:crypto';

export const NEXT_RELEASE_REVIEW_DATE = process.env.FATINAH_BANK_REVIEW_DATE || '2026-09-05';

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function normalizeArabic(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u064b-\u065f\u0670]/gu, '')
    .replace(/[إأآٱ]/gu, 'ا')
    .replace(/ى/gu, 'ي')
    .replace(/ة/gu, 'ه')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function cleanArabic(value) {
  return String(value || '')
    .trim()
    .replace(/\?/gu, '؟')
    .replace(/\s{2,}/gu, ' ')
    .replace(/\s+([،؛:.!?\u061f])/gu, '$1');
}

export function optionTooSimilar(left, right) {
  const a = normalizeArabic(left);
  const b = normalizeArabic(right);
  if (!a || !b || /^\d+(?:[.,]\d+)?$/u.test(a) && /^\d+(?:[.,]\d+)?$/u.test(b)) return false;
  if (Math.min(a.length, b.length) >= 5 && (a.includes(b) || b.includes(a))) return true;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= b.length; column += 1) {
      const old = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + Number(a[row - 1] !== b[column - 1]),
      );
      diagonal = old;
    }
  }
  const distance = previous[b.length];
  if (Math.min(a.length, b.length) >= 3 && Math.max(a.length, b.length) <= 5 && distance <= 1) return true;
  return 1 - distance / Math.max(a.length, b.length) >= 0.82;
}

export function stableSort(rows, key, score = null) {
  return [...rows].sort((left, right) => {
    if (score) {
      const delta = Number(score(right) || 0) - Number(score(left) || 0);
      if (delta) return delta;
    }
    const leftKey = left.id || left.sourceRecordId || left.item || left.itemId || JSON.stringify(left);
    const rightKey = right.id || right.sourceRecordId || right.item || right.itemId || JSON.stringify(right);
    return sha256(`${key}|${leftKey}`).localeCompare(sha256(`${key}|${rightKey}`));
  });
}

function orderedPool(answer, pool, key) {
  const normalizedAnswer = normalizeArabic(answer);
  const tiers = new Map();
  for (const raw of pool) {
    const value = cleanArabic(typeof raw === 'object' ? raw.value : raw);
    const tier = typeof raw === 'object' && raw.tier ? String(raw.tier) : 'default';
    const normalized = normalizeArabic(value);
    if (!normalized || normalized === normalizedAnswer) continue;
    if (![...tiers.values()].some(items => items.some(item => item.normalized === normalized))) {
      if (!tiers.has(tier)) tiers.set(tier, []);
      tiers.get(tier).push({ normalized, value });
    }
  }
  // Rotate deterministically *inside* each authored semantic tier. This keeps
  // regional/same-role distractors ahead of the fallback, while preventing one
  // fixed trio from appearing in nearly every question.
  return [...tiers.entries()].flatMap(([tier, items]) => {
    if (!items.length) return [];
    const offset = Number.parseInt(sha256(`${key}|${tier}`).slice(0, 8), 16) % items.length;
    return [...items.slice(offset), ...items.slice(0, offset)].map(item => item.value);
  });
}

export function makeOptions(answer, pool, key) {
  const correct = cleanArabic(answer);
  const distractors = [];
  for (const value of orderedPool(correct, pool, key)) {
    if (optionTooSimilar(value, correct)) continue;
    if (distractors.some(other => optionTooSimilar(value, other))) continue;
    distractors.push(value);
    if (distractors.length === 3) break;
  }
  if (distractors.length !== 3) throw new Error(`ثلاثة مشتتات متمايزة غير متوفرة: ${key}`);
  const answerIndex = Number.parseInt(sha256(key).slice(0, 8), 16) % 4;
  const options = [...distractors];
  options.splice(answerIndex, 0, correct);
  return { o: options, a: answerIndex, answer: correct };
}

export function difficultyForPosition(position) {
  const bandIndex = Math.floor(position / 30);
  if (bandIndex < 0 || bandIndex > 2) throw new Error(`ترتيب صعوبة غير صالح: ${position}`);
  return {
    band: ['easy', 'medium', 'hard'][bandIndex],
    d: bandIndex * 2 + 1 + (position % 2),
  };
}

export function balancedAnswerIndex(category, position) {
  const offset = Number.parseInt(sha256(`${category}|answer-slot-offset`).slice(0, 8), 16) % 4;
  const band = Math.floor(position / 30);
  const localPosition = position % 30;
  const extraSlots = [
    [offset, (offset + 1) % 4],
    [(offset + 2) % 4, (offset + 3) % 4],
    [offset, (offset + 2) % 4],
  ][band];
  const slots = [
    ...Array.from({ length: 28 }, (_, index) => index % 4),
    ...extraSlots,
  ];
  const layout = slots.map((answerIndex, index) => ({
    answerIndex,
    order: sha256(`${category}|answer-slot-order|${band}|${index}`),
  })).sort((left, right) => left.order.localeCompare(right.order));
  return layout[localPosition].answerIndex;
}

export function finalizeQuestion(category, raw, position) {
  const difficulty = difficultyForPosition(position);
  const q = cleanArabic(raw.q || raw.question);
  const sourceRecordId = String(raw.sourceRecordId || raw.factKey || '').trim();
  const factKey = String(raw.factKey || sourceRecordId).trim();
  if (!q || !sourceRecordId || !factKey) throw new Error(`${category}: سؤال بلا هوية مصدرية`);
  let choice = raw.o
    ? { o: raw.o.map(cleanArabic), a: raw.a, answer: cleanArabic(raw.answer) }
    : makeOptions(raw.answer, raw.answerPool, `${category}|${factKey}`);
  if (choice.o.length === 4 && Number.isInteger(choice.a) && choice.o[choice.a] === choice.answer) {
    const targetIndex = balancedAnswerIndex(category, position);
    const distractors = choice.o.filter((_, index) => index !== choice.a);
    const options = [...distractors];
    options.splice(targetIndex, 0, choice.answer);
    choice = { o: options, a: targetIndex, answer: choice.answer };
  }
  if (choice.o.length !== 4 || new Set(choice.o.map(normalizeArabic)).size !== 4
      || !Number.isInteger(choice.a) || choice.o[choice.a] !== choice.answer) {
    throw new Error(`${category}: خيارات غير صالحة للسؤال ${sourceRecordId}`);
  }
  const id = `gq-${sha256(`next-v2|${category}|${factKey}|${q}`).slice(0, 20)}`;
  return {
    id,
    ...difficulty,
    q,
    ...choice,
    source: raw.source,
    sourceRecordId,
    factKey,
    sourcePacketId: null,
    templateId: raw.templateId,
    editorialGroup: 'next-release',
    rank: Number(raw.rank || 0),
    verification: raw.verification,
    review: {
      status: 'automated_structure_pass',
      reviewer: 'Fatinah deterministic factual gate',
      reviewedAt: NEXT_RELEASE_REVIEW_DATE,
      basis: 'deterministic_source_claim_pending_verification',
      humanReviewRequired: false,
      factualVerificationRequired: true,
    },
    ...(raw.metadata || {}),
  };
}

export function finalizeCategory(category, raws) {
  if (!Array.isArray(raws) || raws.length !== 90) {
    throw new Error(`${category}: المطلوب 90 سؤالاً، وُجد ${raws?.length || 0}`);
  }
  return raws.map((raw, position) => finalizeQuestion(category, raw, position));
}

export function assertNoSimilarOptions(question) {
  for (let left = 0; left < question.o.length; left += 1) {
    for (let right = left + 1; right < question.o.length; right += 1) {
      if (optionTooSimilar(question.o[left], question.o[right])) {
        throw new Error(`${question.id}: خياران متشابهان: ${question.o[left]} | ${question.o[right]}`);
      }
    }
  }
}
