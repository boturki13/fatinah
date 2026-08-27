export const PRICING_AS_OF = '2026-08-24';
export const WEB_SEARCH_USD_PER_CALL = 0.01;
export const WEB_SEARCH_CONTEXT_TOKEN_RESERVE_PER_CALL = 8_000;

export const BUILTIN_MODEL_PRICING = Object.freeze({
  'gpt-5.6-terra': Object.freeze({ inputUsdPerMillion: 2, outputUsdPerMillion: 12 }),
  'gpt-5.6-sol': Object.freeze({ inputUsdPerMillion: 4, outputUsdPerMillion: 20 }),
  'gpt-5.6-luna': Object.freeze({ inputUsdPerMillion: 0.20, outputUsdPerMillion: 1.20 }),
});

function finiteNonNegative(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function safeInteger(value, label) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw new Error(`${label} يجب أن يكون عدداً صحيحاً غير سالب.`);
  return numeric;
}

function customPricing(env) {
  const raw = String(env.FATINAH_OPENAI_MODEL_PRICING_JSON || '').trim();
  if (!raw) return {};
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('FATINAH_OPENAI_MODEL_PRICING_JSON ليس JSON صالحاً.'); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('FATINAH_OPENAI_MODEL_PRICING_JSON يجب أن يكون كائن أسعار حسب اسم النموذج.');
  }
  return parsed;
}

export function resolveModelPricing(model, env = process.env) {
  const modelName = String(model || '').trim();
  if (!modelName) throw new Error('اسم النموذج مطلوب لحساب التكلفة.');
  if (BUILTIN_MODEL_PRICING[modelName]) {
    return { model: modelName, ...BUILTIN_MODEL_PRICING[modelName], source: 'builtin', pricingAsOf: PRICING_AS_OF };
  }
  const configured = customPricing(env)[modelName];
  const input = finiteNonNegative(configured?.inputUsdPerMillion);
  const output = finiteNonNegative(configured?.outputUsdPerMillion);
  if (input === null || output === null) {
    throw new Error(
      `سعر النموذج «${modelName}» غير معروف. أضف له inputUsdPerMillion وoutputUsdPerMillion ` +
      'داخل FATINAH_OPENAI_MODEL_PRICING_JSON قبل أي استدعاء.'
    );
  }
  return {
    model: modelName,
    inputUsdPerMillion: input,
    outputUsdPerMillion: output,
    source: 'env',
    pricingAsOf: PRICING_AS_OF,
  };
}

export function parseMaxSpendUsd(value, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return null;
    throw new Error('يلزم --max-spend-usd قبل أي توليد غير dry-run.');
  }
  if (typeof value === 'boolean') throw new Error('--max-spend-usd يحتاج قيمة رقمية بالدولار.');
  const budget = Number(value);
  if (!Number.isFinite(budget) || budget <= 0) throw new Error('--max-spend-usd يجب أن يكون رقماً موجباً بالدولار.');
  return budget;
}

export function estimateUtf8TokenUpperBound(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  // كل token يحتاج بايتاً واحداً على الأقل؛ عدد بايتات UTF-8 حد أعلى محافظ
  // لا يحتاج tokenizer أو اتصالاً خارجياً.
  return Buffer.byteLength(serialized || '', 'utf8');
}

export function estimateCandidateBatchInputUpperBound(count) {
  const safeCount = safeInteger(count, 'عدد المرشحين');
  // أقصى أطوال حقول generatedQuestionsSchema، مع 4 بايت لكل محرف وحيز JSON.
  const maximumCharacters = 220 + 140 + 420 + 180 + 500 + 120 + 360 + 220;
  const jsonOverheadBytes = 768;
  return safeCount * ((maximumCharacters * 4) + jsonOverheadBytes) + 2;
}

export function calculateResponseCost({
  model,
  inputTokens,
  outputTokens,
  webSearchCalls = 0,
  env = process.env,
}) {
  const pricing = resolveModelPricing(model, env);
  const input = safeInteger(inputTokens, 'inputTokens');
  const output = safeInteger(outputTokens, 'outputTokens');
  const searches = safeInteger(webSearchCalls, 'webSearchCalls');
  const inputCostUsd = (input / 1_000_000) * pricing.inputUsdPerMillion;
  const outputCostUsd = (output / 1_000_000) * pricing.outputUsdPerMillion;
  const webSearchCostUsd = searches * WEB_SEARCH_USD_PER_CALL;
  return {
    model: pricing.model,
    pricingSource: pricing.source,
    pricingAsOf: pricing.pricingAsOf,
    inputTokens: input,
    outputTokens: output,
    webSearchCalls: searches,
    inputCostUsd,
    outputCostUsd,
    webSearchCostUsd,
    estimatedUsd: inputCostUsd + outputCostUsd + webSearchCostUsd,
  };
}

export function estimateResponseReserve({
  model,
  inputTokenUpperBound,
  maxOutputTokens,
  maxToolCalls,
  env = process.env,
}) {
  const promptInputTokens = safeInteger(inputTokenUpperBound, 'inputTokenUpperBound');
  const toolCalls = safeInteger(maxToolCalls, 'maxToolCalls');
  // نتائج البحث تدخل سياق النموذج وقد تظهر ضمن input usage. نحجز 8K tokens
  // لكل استدعاء إضافة إلى رسم الأداة، حتى لا يعتمد preflight على prompt وحده.
  const toolContextInputTokenReserve = toolCalls * WEB_SEARCH_CONTEXT_TOKEN_RESERVE_PER_CALL;
  return {
    kind: 'conservative_upper_bound',
    ...calculateResponseCost({
      model,
      inputTokens: promptInputTokens + toolContextInputTokenReserve,
      outputTokens: safeInteger(maxOutputTokens, 'maxOutputTokens'),
      webSearchCalls: toolCalls,
      env,
    }),
    promptInputTokenUpperBound: promptInputTokens,
    toolContextInputTokenReserve,
    maxOutputTokens,
    maxToolCalls: toolCalls,
  };
}

export function countWebSearchCalls(response) {
  return (Array.isArray(response?.output) ? response.output : [])
    .filter(item => item?.type === 'web_search_call').length;
}

export function summarizeResponseUsage(response, model, env = process.env) {
  const usage = response?.usage;
  if (!usage || usage.input_tokens === undefined || usage.output_tokens === undefined) {
    throw new Error('استجابة OpenAI لا تحتوي usage كاملاً؛ أُوقف خط الإنتاج قبل المرحلة التالية والكتابة.');
  }
  const cost = calculateResponseCost({
    model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    webSearchCalls: countWebSearchCalls(response),
    env,
  });
  return {
    ...cost,
    kind: 'actual_usage_estimate',
    totalTokens: safeInteger(usage.total_tokens ?? (cost.inputTokens + cost.outputTokens), 'totalTokens'),
    cachedInputTokens: safeInteger(usage.input_tokens_details?.cached_tokens ?? 0, 'cachedInputTokens'),
    reasoningOutputTokens: safeInteger(usage.output_tokens_details?.reasoning_tokens ?? 0, 'reasoningOutputTokens'),
  };
}

export function totalEstimatedUsd(...items) {
  return items.flat().reduce((sum, item) => sum + Number(item?.estimatedUsd || 0), 0);
}

export function assertWithinBudget(estimatedUsd, budgetUsd, stage) {
  const estimated = Number(estimatedUsd);
  const budget = Number(budgetUsd);
  if (!Number.isFinite(estimated) || estimated < 0 || !Number.isFinite(budget) || budget <= 0) {
    throw new Error('تعذر التحقق من ميزانية التوليد بأرقام صالحة.');
  }
  if (estimated > budget) {
    throw new Error(
      `${stage}: الحد الأعلى المتوقع $${estimated.toFixed(6)} يتجاوز الميزانية $${budget.toFixed(6)}؛ ` +
      'لم تُنفذ المرحلة التالية ولم تُكتب candidates.'
    );
  }
  return true;
}
