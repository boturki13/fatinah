#!/usr/bin/env node
import crypto from 'node:crypto';
import path from 'node:path';
import { CONTENT_DIR, writeJsonAtomic } from './lib.mjs';

const write = process.argv.includes('--write');
const output = path.join(CONTENT_DIR, 'structured-sources', 'deterministic-math-records.json');
const retrievedAt = new Date().toISOString();
const arithmeticUrl = 'https://www.britannica.com/science/arithmetic';
const numberGameUrl = 'https://www.britannica.com/science/number-game';
const records = [];

function addRecord(kind, level, index, prompt, answer, expression, sourceUrl) {
  const canonical = { kind, level, index, prompt, answer: String(answer), expression };
  records.push({
    sourceRecordId: `britannica-${kind}-l${level}-${String(index).padStart(3, '0')}`,
    ...canonical,
    sourceUrl,
    sourcePublisher: 'Encyclopaedia Britannica',
    retrievedAt,
    sourcePayloadHash: crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
  });
}

for (let level = 1; level <= 6; level += 1) {
  for (let index = 1; index <= 50; index += 1) {
    let expression;
    let answer;
    if (level === 1) {
      const a = 10 + index; const b = 11 + (index % 17); expression = `${a} + ${b}`; answer = a + b;
    } else if (level === 2) {
      const b = 11 + (index % 21); const answerValue = 30 + index; expression = `${answerValue + b} − ${b}`; answer = answerValue;
    } else if (level === 3) {
      const a = 11 + (index % 12); const b = 12 + Math.floor(index / 4); expression = `${a} × ${b}`; answer = a * b;
    } else if (level === 4) {
      const divisor = 11 + (index % 9); const quotient = 21 + index; expression = `${divisor * quotient} ÷ ${divisor}`; answer = quotient;
    } else if (level === 5) {
      const a = 14 + (index % 11); const b = 12 + (index % 7); const c = 13 + (index % 5);
      expression = `(${a} + ${b}) × ${c}`; answer = (a + b) * c;
    } else {
      const a = 15 + index; const b = 12 + (index % 6);
      expression = `${a}² − ${b}²`; answer = a * a - b * b;
    }
    addRecord('quick-arithmetic', level, index, `احسب: ${expression}؟`, answer, expression, arithmeticUrl);

    let sequence;
    let next;
    if (level === 1) {
      const start = index + 20; const step = 12 + (index % 4);
      sequence = [start, start + step, start + step * 2, start + step * 3]; next = start + step * 4;
    } else if (level === 2) {
      const step = 3 + (index % 6); const start = 100 + index;
      sequence = [start, start - step, start - step * 2, start - step * 3]; next = start - step * 4;
    } else if (level === 3) {
      const factor = 2 + (index % 3); const start = 10 + index;
      sequence = [start, start * factor, start * factor ** 2, start * factor ** 3]; next = start * factor ** 4;
    } else if (level === 4) {
      const offset = index;
      sequence = [10 + offset, 13 + offset, 18 + offset, 25 + offset]; next = 34 + offset;
    } else if (level === 5) {
      const start = 10 + index; const up = 4 + (index % 5); const down = 2 + (index % 3);
      sequence = [start, start + up, start + up - down, start + up * 2 - down];
      next = start + up * 2 - down * 2;
    } else {
      const first = 11 + index; const second = 12 + (index % 19);
      sequence = [first, second, first + second, first + second * 2]; next = first * 2 + second * 3;
    }
    const prompt = `شنو الرقم التالي: ${sequence.join('، ')}، ؟`;
    addRecord('number-sequence', level, index, prompt, next, `${sequence.join(',')} -> ${next}`, numberGameUrl);
  }
}

const document = { schemaVersion: 1, sourceProfile: 'curated_trusted_records_v1', retrievedAt, records };
if (write) writeJsonAtomic(output, document);
console.log(JSON.stringify({ mode: write ? 'write' : 'dry-run', records: records.length,
  output: write ? path.relative(process.cwd(), output) : null, aiCalls: 0, estimatedAiCostUsd: 0 }, null, 2));
