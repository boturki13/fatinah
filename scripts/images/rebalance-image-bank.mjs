#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { rebalanceImageBankDifficulty } from './image-bank-difficulty.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bankPath = path.join(root, 'www/image-question-bank-commons.js');
const source = await fs.readFile(bankPath, 'utf8');
const context = { window: {} };
vm.runInNewContext(source, context, { timeout: 1_000 });
const bank = JSON.parse(JSON.stringify(context.window.__IMAGE_QUESTION_COMMONS_DATA__ || {}));
rebalanceImageBankDifficulty(bank);
for (const [category, questions] of Object.entries(bank)) {
  console.log(`✓ ${category}: أعيد توزيع ${questions.length} سؤالاً`);
}

const output = `window.__IMAGE_QUESTION_COMMONS_DATA__=${JSON.stringify(bank)};\n(()=>{const target=window.__IMAGE_QUESTION_BANK_DATA__||(window.__IMAGE_QUESTION_BANK_DATA__={});for(const [category,questions] of Object.entries(window.__IMAGE_QUESTION_COMMONS_DATA__))target[category]=[...(Array.isArray(target[category])?target[category]:[]),...questions];})();\n`;
await fs.writeFile(bankPath, output);
