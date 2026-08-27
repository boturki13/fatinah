#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANDIDATES_PATH,
  CONTENT_DIR,
  PUBLISHED_PATH,
  isReligiousCategory,
  loadBaseCategories,
  loadReleaseImageQuestionBank,
  loadPolicy,
  loadRuntimeQuestionBank,
  readJson,
  writeJsonAtomic,
} from './lib.mjs';

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    result[key] = argv[index + 1]?.startsWith('--') || argv[index + 1] === undefined ? true : argv[++index];
  }
  return result;
}

function distribute(total, keys) {
  if (!Number.isSafeInteger(total) || total < 0 || !keys.length) throw new Error('تعذر توزيع هدف البنك.');
  const base = Math.floor(total / keys.length);
  const remainder = total % keys.length;
  return Object.fromEntries(keys.map((key, index) => [key, base + (index < remainder ? 1 : 0)]));
}

function distributeWithMinimum(total, keys, minimums = {}) {
  if (!Number.isSafeInteger(total) || total < 0 || !keys.length) {
    throw new Error('تعذر توزيع هدف البنك مع الحدود الدنيا.');
  }
  const allocations = Object.fromEntries(keys.map(key => {
    const minimum = Number(minimums[key] || 0);
    if (!Number.isSafeInteger(minimum) || minimum < 0) throw new Error(`حد أدنى غير صالح: ${key}.`);
    return [key, minimum];
  }));
  let remaining = total - Object.values(allocations).reduce((sum, value) => sum + value, 0);
  if (remaining < 0) throw new Error(`الهدف ${total} أصغر من الأسئلة الجاهزة فعلياً.`);
  while (remaining > 0) {
    let selected = keys[0];
    for (const key of keys) if (allocations[key] < allocations[selected]) selected = key;
    allocations[selected] += 1;
    remaining -= 1;
  }
  return allocations;
}

export function buildExactBankPlan({ targetBankSize, policy = loadPolicy() } = {}) {
  const target = Number(targetBankSize ?? policy.targetBankSize);
  if (!Number.isSafeInteger(target) || target < 1 || target > 100_000) {
    throw new Error('targetBankSize يجب أن يكون عدداً صحيحاً من 1 إلى 100000.');
  }
  const textCategories = loadBaseCategories();
  const runtime = loadRuntimeQuestionBank().bank;
  // لا تدخل خطة الإصدار إلا الصور المعتمدة والقابلة للنشر فعلياً.
  // فئة اللاعبين تبقى خارج العدّ إلى أن تُعتمد حقوق الاسم والصورة التجارية.
  const imageBank = loadReleaseImageQuestionBank();
  const imageCategories = Object.keys(imageBank);
  const internalCategories = [...new Set([...textCategories, ...imageCategories])];
  const religiousCategories = internalCategories.filter(category => isReligiousCategory(category, policy));
  const publishedIds = new Set(readJson(PUBLISHED_PATH, []).map(candidate => candidate.id));
  const stagedApproved = readJson(CANDIDATES_PATH, []).filter(candidate =>
    candidate?.status === 'approved' && !publishedIds.has(candidate.id));
  const knownCategories = new Set(internalCategories);
  for (const candidate of stagedApproved) {
    if (!knownCategories.has(candidate.category)) {
      throw new Error(`مرشح معتمد ضمن فئة غير معروفة: ${candidate.category}.`);
    }
  }
  const currentLevels = {};
  for (const category of internalCategories) {
    currentLevels[category] = Object.fromEntries([1, 2, 3, 4, 5, 6].map(level => [level, 0]));
  }
  for (const [category, questions] of Object.entries(runtime)) {
    for (const question of questions) {
      const level = Number(question.d);
      if (currentLevels[category]?.[level] != null) currentLevels[category][level] += 1;
    }
  }
  for (const [category, questions] of Object.entries(imageBank)) {
    for (const question of questions) {
      const level = Number(question.d);
      if (currentLevels[category]?.[level] == null) throw new Error(`${category}: مستوى صورة غير صالح.`);
      currentLevels[category][level] += 1;
    }
  }
  for (const candidate of stagedApproved) {
    const level = Number(candidate.difficultyLevel);
    if (currentLevels[candidate.category]?.[level] == null) {
      throw new Error(`${candidate.id}: مستوى المرشح المعتمد غير صالح.`);
    }
    currentLevels[candidate.category][level] += 1;
  }
  const visibleCategories = [
    ...internalCategories.filter(category => !religiousCategories.includes(category)),
    ...(religiousCategories.length ? ['إسلاميات'] : []),
  ];
  const currentByCategory = Object.fromEntries(internalCategories.map(category => [
    category, Object.values(currentLevels[category]).reduce((sum, count) => sum + count, 0),
  ]));
  const currentByVisibleCategory = Object.fromEntries(visibleCategories.map(category => [
    category,
    category === 'إسلاميات'
      ? religiousCategories.reduce((sum, internal) => sum + currentByCategory[internal], 0)
      : currentByCategory[category],
  ]));
  const currentTotalBeforeTarget = Object.values(currentByCategory).reduce((sum, count) => sum + count, 0);
  if (currentTotalBeforeTarget > target) {
    throw new Error(`البنك الجاهز ${currentTotalBeforeTarget} يتجاوز الهدف ${target}.`);
  }
  // نحافظ على أساس 125 سؤالاً لكل فئة ظاهرة في إصدار 5000، ثم نضع
  // الزيادة أولاً في الفئات الحسابية الحتمية ذات السعة المعروفة.
  const baseline = target >= visibleCategories.length * 125 ? 125 : 0;
  const visibleTargets = Object.fromEntries(visibleCategories.map(category => [
    category, Math.max(currentByVisibleCategory[category], baseline),
  ]));
  let remaining = target - Object.values(visibleTargets).reduce((sum, count) => sum + count, 0);
  if (remaining < 0) throw new Error(`الحد الأدنى للفئات يتجاوز الهدف ${target}.`);
  const deterministicGrowth = ['إجابة سريعة', 'ألغاز وتحدّي ذكاء']
    .filter(category => category in visibleTargets);
  while (remaining > 0 && deterministicGrowth.some(category => visibleTargets[category] < 300)) {
    for (const category of deterministicGrowth) {
      if (remaining === 0) break;
      if (visibleTargets[category] >= 300) continue;
      visibleTargets[category] += 1;
      remaining -= 1;
    }
  }
  if (remaining > 0) {
    Object.assign(visibleTargets, distributeWithMinimum(
      target, visibleCategories, visibleTargets,
    ));
  }
  const internalTargets = {};
  for (const category of visibleCategories) {
    if (category === 'إسلاميات') {
      Object.assign(internalTargets, distributeWithMinimum(
        visibleTargets[category], religiousCategories,
        Object.fromEntries(religiousCategories.map(item => [item, currentByCategory[item]])),
      ));
    }
    else internalTargets[category] = visibleTargets[category];
  }
  const categories = {};
  let targetTotal = 0;
  let currentTotal = 0;
  let gapTotal = 0;
  for (const category of internalCategories) {
    const levelTargets = distributeWithMinimum(
      internalTargets[category], [1, 2, 3, 4, 5, 6], currentLevels[category]);
    const levels = {};
    for (let level = 1; level <= 6; level += 1) {
      const current = currentLevels[category][level];
      const levelTarget = levelTargets[level];
      const gap = levelTarget - current;
      levels[level] = { current, target: levelTarget, gap };
      targetTotal += levelTarget;
      currentTotal += current;
      gapTotal += gap;
    }
    categories[category] = {
      visibleCategory: isReligiousCategory(category, policy) ? 'إسلاميات' : category,
      kind: imageCategories.includes(category) ? 'image' : 'text',
      target: internalTargets[category],
      levels,
    };
  }
  if (targetTotal !== target) throw new Error(`خطأ داخلي: مجموع الخطة ${targetTotal} بدلاً من ${target}.`);
  return {
    schemaVersion: 1,
    targetBankSize: target,
    futureTargetBankSize: Number(policy.futureTargetBankSize || 15000),
    visibleCategoryCount: visibleCategories.length,
    internalCategoryCount: internalCategories.length,
    currentTotal,
    gapTotal,
    components: {
      runtimeText: Object.values(runtime).reduce((sum, questions) => sum + questions.length, 0),
      runtimeImages: Object.values(imageBank).reduce((sum, questions) => sum + questions.length, 0),
      stagedApproved: stagedApproved.length,
    },
    visibleTargets,
    categories,
  };
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const args = options(process.argv.slice(2));
  const plan = buildExactBankPlan({ targetBankSize: args.target });
  if (args.write === true) {
    const output = path.join(CONTENT_DIR, `bank-plan-${plan.targetBankSize}.json`);
    writeJsonAtomic(output, plan);
    console.log(JSON.stringify({ ...plan, output: path.relative(process.cwd(), output) }, null, 2));
  } else {
    console.log(JSON.stringify(plan, null, 2));
  }
}
