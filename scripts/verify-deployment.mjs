#!/usr/bin/env node

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
requireCondition(version.body?.features?.revenuecat_webhook === true,
  'ميزة RevenueCat webhook غير مفعلة');
for (const feature of ['game_packs', 'question_admin', 'question_reports']) {
  requireCondition(version.body?.features?.[feature] === true,
    `ميزة ${feature} غير مفعلة`);
}

for (const route of [
  '/api/v2/questions/catalog',
  '/api/v2/questions/round',
  '/api/v2/questions/reveal',
  '/api/v2/generate',
]) {
  const probe = await request(route, {
    method: route.endsWith('/catalog') ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(route.endsWith('/catalog') ? {} : { body: '{}' }),
  });
  requireCondition(probe.response.status === 410,
    `${route} يجب أن يبقى محذوفاً؛ HTTP ${probe.response.status}`);
  requireCondition(probe.body?.code === 'question_content_removed',
    `${route} أعاد عقد حذف غير متوقع`);
}

const revenueCat = await request('/api/v2/rc-config');
requireCondition(revenueCat.response.status === 200, `rc-config HTTP ${revenueCat.response.status}`);
requireCondition(/^appl_[A-Za-z0-9_-]{8,}$/u.test(String(revenueCat.body?.apiKey || '')),
  'مفتاح RevenueCat العام غير موجود أو غير صالح');

const adminSession = await request('/api/v2/admin/session');
requireCondition(adminSession.response.status === 200, `admin/session HTTP ${adminSession.response.status}`);
requireCondition(adminSession.body?.authenticated === false,
  'جلسة الجودة العامة يجب ألا تكون مصادقاً عليها');

console.log(JSON.stringify({
  ready: true,
  origin: origin.origin,
  environment: version.body.environment,
  applicationRelease: version.body.applicationRelease,
  contractRevision: version.body.contractRevision,
  legacyQuestionContent: 'removed',
  questionPlatform: 'v2-ready',
}, null, 2));
