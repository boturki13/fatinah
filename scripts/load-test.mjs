#!/usr/bin/env node
/**
 * اختبار ضغط آمن ومتدرج لخادم فطنة.
 *
 * لا يفترض عنواناً افتراضياً ولا يبدأ أي شبكة من دون موافقة بيئية صريحة.
 * السيناريو العام يقيس بوابة API وAutoscale. اختبار الجولة المحمية يحتاج
 * حسابات اختبار مستقلة وApp Check، لذلك لا يضيف هذا الملف أي مسار خلفي.
 */

import { setTimeout as delay } from 'node:timers/promises';

export const DEFAULT_STAGES = Object.freeze([
  { users: 100, durationSeconds: 300 },
  { users: 300, durationSeconds: 300 },
  { users: 500, durationSeconds: 600 },
  { users: 1000, durationSeconds: 600 },
]);

const args = new Set(process.argv.slice(2));
const planOnly = args.has('--plan');
const durationScale = Number(process.env.FATINAH_LOAD_TEST_DURATION_SCALE || '1');
if (!Number.isFinite(durationScale) || durationScale < 0.05 || durationScale > 10) {
  throw new Error('FATINAH_LOAD_TEST_DURATION_SCALE يجب أن يكون بين 0.05 و10');
}

const stages = DEFAULT_STAGES.map(stage => ({
  ...stage,
  durationSeconds: Math.max(10, Math.round(stage.durationSeconds * durationScale)),
}));

if (planOnly) {
  console.log(JSON.stringify({ scenario: 'api-autoscale-baseline', stages }, null, 2));
  process.exit(0);
}

const rawTarget = String(process.env.FATINAH_LOAD_TEST_URL || '').trim();
const approval = String(process.env.FATINAH_LOAD_TEST_APPROVED || '').trim();
if (!rawTarget) throw new Error('حدد FATINAH_LOAD_TEST_URL لنسخة staging');

const target = new URL(rawTarget);
const isLocal = ['localhost', '127.0.0.1', '::1'].includes(target.hostname);
if (isLocal) {
  if (approval !== 'local') throw new Error('الاختبار المحلي يحتاج FATINAH_LOAD_TEST_APPROVED=local');
} else {
  if (target.protocol !== 'https:') throw new Error('اختبار الشبكة الخارجية يحتاج HTTPS');
  if (approval !== `staging:${target.hostname}`) {
    throw new Error(`أكد staging فقط بالقيمة FATINAH_LOAD_TEST_APPROVED=staging:${target.hostname}`);
  }
}
if (target.username || target.password || target.search || target.hash) {
  throw new Error('عنوان الاختبار لا يقبل بيانات دخول أو query أو fragment');
}

const endpoint = new URL('/api/v2/version', target);
const timeoutMs = 5000;
const thinkMinMs = 8000;
const thinkMaxMs = 20000;

function percentile(sorted, fraction) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function requestVersion(metrics) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(endpoint, {
      signal: controller.signal,
      headers: { 'X-Fatinah-API-Version': '2', 'Accept': 'application/json' },
    });
    await response.arrayBuffer();
    metrics.statuses.set(response.status, (metrics.statuses.get(response.status) || 0) + 1);
    if (response.ok) metrics.ok += 1;
    else metrics.failed += 1;
  } catch {
    metrics.failed += 1;
    metrics.networkErrors += 1;
  } finally {
    clearTimeout(timer);
    metrics.latencies.push(performance.now() - started);
  }
}

async function runVirtualPlayer(deadline, metrics, index) {
  // توزيع أول طلب يمنع قفزة مصطنعة في الملي ثانية نفسها، مع بقاء التزامن.
  await delay(index % 1000);
  while (performance.now() < deadline && !metrics.stop) {
    await requestVersion(metrics);
    const thinkTime = thinkMinMs + Math.random() * (thinkMaxMs - thinkMinMs);
    await delay(thinkTime);
  }
}

let shouldStop = false;
for (const stage of stages) {
  if (shouldStop) break;
  const metrics = {
    ok: 0, failed: 0, networkErrors: 0, latencies: [], statuses: new Map(), stop: false,
  };
  const deadline = performance.now() + stage.durationSeconds * 1000;
  await Promise.all(Array.from(
    { length: stage.users },
    (_, index) => runVirtualPlayer(deadline, metrics, index),
  ));

  const sorted = metrics.latencies.toSorted((a, b) => a - b);
  const total = metrics.ok + metrics.failed;
  const errorRate = total ? metrics.failed / total : 1;
  const summary = {
    users: stage.users,
    durationSeconds: stage.durationSeconds,
    requests: total,
    ok: metrics.ok,
    failed: metrics.failed,
    networkErrors: metrics.networkErrors,
    errorRate: Number(errorRate.toFixed(4)),
    p50Ms: Math.round(percentile(sorted, 0.50)),
    p95Ms: Math.round(percentile(sorted, 0.95)),
    p99Ms: Math.round(percentile(sorted, 0.99)),
    statuses: Object.fromEntries([...metrics.statuses].sort((a, b) => a[0] - b[0])),
  };
  console.log(JSON.stringify(summary));
  shouldStop = errorRate > 0.05 || summary.p95Ms > 3000;
  if (shouldStop) console.error('أُوقف التصعيد: تجاوزت المرحلة حد الأخطاء أو p95 الآمن.');
  else await delay(120_000);
}

process.exitCode = shouldStop ? 1 : 0;
