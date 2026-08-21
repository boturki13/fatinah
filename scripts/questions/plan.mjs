#!/usr/bin/env node
import { buildRuntimeQuestionPlan, loadPolicy } from './lib.mjs';

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    result[key] = argv[index + 1]?.startsWith('--') || argv[index + 1] === undefined
      ? true
      : argv[++index];
  }
  return result;
}

const args = options(process.argv.slice(2));
const policy = loadPolicy();
const targetPerLevel = args['target-per-level'] === undefined
  ? Number(policy.targetQuestionsPerLevel || 4)
  : Number.parseInt(args['target-per-level'], 10);
const categories = args.category === undefined
  ? null
  : String(args.category).split(',').map(category => category.trim()).filter(Boolean);

const plan = buildRuntimeQuestionPlan({ targetPerLevel, categories });
console.log(JSON.stringify(plan, null, 2));
