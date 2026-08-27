import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BUILTIN_MODEL_PRICING,
  PRICING_AS_OF,
  WEB_SEARCH_CONTEXT_TOKEN_RESERVE_PER_CALL,
  assertWithinBudget,
  calculateResponseCost,
  countWebSearchCalls,
  estimateCandidateBatchInputUpperBound,
  estimateResponseReserve,
  estimateUtf8TokenUpperBound,
  parseMaxSpendUsd,
  resolveModelPricing,
  summarizeResponseUsage,
  totalEstimatedUsd,
} from '../scripts/questions/cost.mjs';

assert.equal(PRICING_AS_OF, '2026-08-24');
assert.deepEqual(BUILTIN_MODEL_PRICING['gpt-5.6-terra'], { inputUsdPerMillion: 2, outputUsdPerMillion: 12 });
assert.deepEqual(BUILTIN_MODEL_PRICING['gpt-5.6-sol'], { inputUsdPerMillion: 4, outputUsdPerMillion: 20 });
assert.deepEqual(BUILTIN_MODEL_PRICING['gpt-5.6-luna'], { inputUsdPerMillion: 0.2, outputUsdPerMillion: 1.2 });
assert.throws(() => resolveModelPricing('future-unknown-model', {}), /سعر النموذج.*غير معروف/);
assert.deepEqual(
  resolveModelPricing('private-priced-model', {
    FATINAH_OPENAI_MODEL_PRICING_JSON: JSON.stringify({
      'private-priced-model': { inputUsdPerMillion: 7, outputUsdPerMillion: 35 },
    }),
  }),
  {
    model: 'private-priced-model', inputUsdPerMillion: 7, outputUsdPerMillion: 35,
    source: 'env', pricingAsOf: '2026-08-24',
  },
);
assert.throws(
  () => resolveModelPricing('partial-model', {
    FATINAH_OPENAI_MODEL_PRICING_JSON: '{"partial-model":{"inputUsdPerMillion":3}}',
  }),
  /outputUsdPerMillion/,
);

assert.throws(() => parseMaxSpendUsd(undefined), /--max-spend-usd/);
assert.throws(() => parseMaxSpendUsd(true), /قيمة رقمية/);
assert.throws(() => parseMaxSpendUsd('0'), /رقماً موجباً/);
assert.equal(parseMaxSpendUsd(undefined, { required: false }), null);
assert.equal(parseMaxSpendUsd('1.25'), 1.25);

assert.ok(estimateUtf8TokenUpperBound('سؤال عربي') >= 'سؤال عربي'.length);
assert.ok(estimateCandidateBatchInputUpperBound(2) > estimateCandidateBatchInputUpperBound(1));

const terraCost = calculateResponseCost({
  model: 'gpt-5.6-terra', inputTokens: 1_000, outputTokens: 2_000, webSearchCalls: 3,
});
assert.equal(terraCost.inputCostUsd, 0.002);
assert.equal(terraCost.outputCostUsd, 0.024);
assert.equal(terraCost.webSearchCostUsd, 0.03);
assert.equal(terraCost.estimatedUsd, 0.056);

const mockResponse = {
  id: 'resp_safe_test',
  usage: {
    input_tokens: 1_000,
    output_tokens: 2_000,
    total_tokens: 3_000,
    input_tokens_details: { cached_tokens: 250 },
    output_tokens_details: { reasoning_tokens: 500 },
  },
  output: [
    { type: 'web_search_call', id: 'search_1' },
    { type: 'message', content: [] },
    { type: 'web_search_call', id: 'search_2' },
  ],
};
assert.equal(countWebSearchCalls(mockResponse), 2);
const actualUsage = summarizeResponseUsage(mockResponse, 'gpt-5.6-terra');
assert.equal(actualUsage.estimatedUsd, 0.046);
assert.equal(actualUsage.totalTokens, 3_000);
assert.equal(actualUsage.cachedInputTokens, 250);
assert.equal(actualUsage.reasoningOutputTokens, 500);
assert.doesNotMatch(JSON.stringify(actualUsage), /OPENAI_API_KEY|sk-[a-z0-9]/i);
assert.throws(() => summarizeResponseUsage({ output: [] }, 'gpt-5.6-terra'), /لا تحتوي usage/);

const verificationReserve = estimateResponseReserve({
  model: 'gpt-5.6-sol', inputTokenUpperBound: 10_000, maxOutputTokens: 3_000, maxToolCalls: 2,
});
assert.equal(WEB_SEARCH_CONTEXT_TOKEN_RESERVE_PER_CALL, 8_000);
assert.equal(verificationReserve.toolContextInputTokenReserve, 16_000);
assert.equal(verificationReserve.inputTokens, 26_000);
assert.ok(Math.abs(verificationReserve.estimatedUsd - 0.184) < 1e-12);
const generationPlusReserve = totalEstimatedUsd(actualUsage, verificationReserve);
assert.ok(Math.abs(generationPlusReserve - 0.23) < 1e-12);
assert.equal(assertWithinBudget(generationPlusReserve, 0.24, 'test'), true);
assert.throws(() => assertWithinBudget(generationPlusReserve, 0.22, 'before_verification'), /لم تُنفذ المرحلة التالية/);

const generator = fs.readFileSync(new URL('../scripts/questions/generate.mjs', import.meta.url), 'utf8');
assert.equal((generator.match(/max_output_tokens:/g) || []).length, 2, 'كل Responses call يحتاج max_output_tokens.');
assert.equal((generator.match(/max_tool_calls:/g) || []).length, 2, 'كل Responses call يحتاج max_tool_calls.');
assert.match(generator, /parseMaxSpendUsd\(args\['max-spend-usd'\]/);
const preflightGuard = generator.indexOf("assertWithinBudget(preflightEstimatedUsd");
const generationCall = generator.indexOf('createResponse(generationPayload)');
const reserveGuard = generator.indexOf("assertWithinBudget(generationPlusVerificationReserveUsd");
const verificationCall = generator.indexOf('createResponse(verificationPayload)');
const candidateWrite = generator.indexOf('writeJsonAtomic(CANDIDATES_PATH');
assert.ok(preflightGuard >= 0 && preflightGuard < generationCall, 'فحص الميزانية القصوى يجب أن يسبق generation.');
assert.ok(reserveGuard >= 0 && reserveGuard < verificationCall, 'فحص generation + verification reserve يجب أن يسبق verification.');
assert.ok(verificationCall < candidateWrite, 'لا تكتب candidates قبل اكتمال verification وفحص التكلفة.');

console.log('✓ حارس التكلفة: أسعار معروفة/مخصصة، ميزانية إلزامية، usage فعلي واحتياطي verification');
console.log('✓ كل Responses call محدود بـ max_output_tokens وmax_tool_calls قبل أي كتابة');
