#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originValue = String(process.env.FATINAH_VERIFY_ORIGIN || '').trim();
if (!originValue) {
  throw new Error('FATINAH_VERIFY_ORIGIN مطلوب صراحةً؛ مثال: https://staging.example.com');
}
const origin = new URL(originValue);
if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
    || (origin.protocol === 'http:' && !['127.0.0.1', 'localhost', '::1'].includes(origin.hostname))) {
  throw new Error('وجهة التحقق يجب أن تكون HTTPS أو خادم loopback محليًا');
}
origin.pathname = '/'; origin.search = ''; origin.hash = '';

const localTextBank = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'server-assets/question-bank/v1/bank.json'), 'utf8'));
const localImageBank = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'server-assets/question-images/curated-question-bank.json'), 'utf8'));
const expectedQuestionCount = localTextBank.questionCount + localImageBank.questionCount;
const expectedCategoryCount = Object.keys(localTextBank.categories).length
  + Object.keys(localImageBank.categories).length;
const retiredCategories = new Set(['رتّبها صح', 'رياضيات وحساب', 'ألغاز بوليسية']);

async function request(pathname, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(new URL(pathname, origin), {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'X-Fatinah-API-Version': '2',
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* checked by callers */ }
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

const version = await request('/api/v2/version');
requireCondition(version.response.status === 200, `version HTTP ${version.response.status}`);
requireCondition(version.body?.apiVersion === '2', 'الخادم لم يثبت عقد API v2');
requireCondition(version.body?.applicationRelease === '1.4.0', 'إصدار الخادم لا يطابق 1.4.0');
requireCondition(version.body?.contractRevision === 'fatinah-v2-2026-09-08', 'مراجعة عقد الخادم قديمة');
for (const feature of ['question_bank', 'question_history', 'question_reports', 'revenuecat_webhook']) {
  requireCondition(version.body?.features?.[feature] === true, `ميزة الخادم غير مفعلة: ${feature}`);
}

const catalog = await request('/api/v2/questions/catalog');
requireCondition(catalog.response.status === 200, `catalog HTTP ${catalog.response.status}`);
requireCondition(catalog.body?.schemaVersion === 1 && catalog.body?.releaseReady === true,
  'كتالوج الأسئلة غير معتمد للنشر');
requireCondition(catalog.body?.questionCount === expectedQuestionCount,
  `عدد الأسئلة المنشور ${catalog.body?.questionCount} بدل ${expectedQuestionCount}`);
requireCondition(catalog.body?.categories?.length === expectedCategoryCount,
  `عدد الفئات المنشور ${catalog.body?.categories?.length} بدل ${expectedCategoryCount}`);
requireCondition(catalog.body?.components?.text === localTextBank.bankVersion,
  'نسخة بنك الأسئلة النصية المنشورة لا تطابق المرشح المحلي');
requireCondition(catalog.body?.components?.image === localImageBank.bankVersion,
  'نسخة بنك الصور المنشورة لا تطابق المرشح المحلي');
requireCondition(catalog.body.categories.every(category => !retiredCategories.has(category.name)),
  'الخادم يعرض فئة ملغاة');

for (const route of ['/api/v2/questions/round', '/api/v2/questions/reveal']) {
  const probe = await request(route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  requireCondition(probe.response.status === 401,
    `${route} غير منشور بعقد 1.4؛ HTTP ${probe.response.status}`);
}

const revenueCat = await request('/api/v2/rc-config');
requireCondition(revenueCat.response.status === 200, `rc-config HTTP ${revenueCat.response.status}`);
requireCondition(/^appl_[A-Za-z0-9_-]{8,}$/u.test(String(revenueCat.body?.apiKey || '')),
  'مفتاح RevenueCat العام غير موجود أو غير صالح');

console.log(JSON.stringify({
  ready: true,
  origin: origin.origin,
  environment: version.body.environment,
  applicationRelease: version.body.applicationRelease,
  contractRevision: version.body.contractRevision,
  questionCount: catalog.body.questionCount,
  categoryCount: catalog.body.categories.length,
  bankVersion: catalog.body.bankVersion,
}, null, 2));
