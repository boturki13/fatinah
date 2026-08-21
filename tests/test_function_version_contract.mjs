#!/usr/bin/env node
/** عقد Cloud Functions: v1 متوافق، وv2 لا يصل إلى مزود الذكاء الاصطناعي. */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

delete process.env.FATINAH_ENVIRONMENT;
delete process.env.FATINAH_V1_SUBSCRIPTION_STATUS_URL;
delete process.env.FATINAH_V1_SUBSCRIPTION_ALLOWED_HOSTS;

const require = createRequire(import.meta.url);
const contract = require('../functions/api-contract.js');
const networkPolicy = require('../functions/network-policy.js');
const trustedSource = require('../functions/trusted-source.js');
const functionSource = readFileSync(
  new URL('../functions/index.js', import.meta.url),
  'utf8',
);

// يمنع رجوع صيغة firebase-admin القديمة التي تفشل عند تحميل الحزمة الحديثة،
// ويثبت أن توكن Firebase الملغى لا يُقبل في مسار v1 القديم.
if (functionSource.includes('admin.apps')) {
  throw new Error('Cloud Function ما زالت تستخدم admin.apps القديمة');
}
if (!functionSource.includes('verifyIdToken(idToken, true)')) {
  throw new Error('Cloud Function لا تتحقق من إلغاء Firebase ID token');
}
const handlers = require('../functions/index.js');
if (!handlers.generateQuestions || !handlers.generateQuestionsV2) {
  throw new Error('تعذر تحميل أسماء Cloud Function المتوقعة');
}

function request(version, body = {}) {
  return {
    method: 'POST',
    body,
    get(name) {
      return name.toLowerCase() === 'x-fatinah-api-version' ? version : undefined;
    },
  };
}

// غياب الرأس هو v1 في الاسم القديم، حفاظاً على تطبيق 1.2.
if (!contract.apiVersionAllows(request(undefined), '1')) {
  throw new Error('عقد v1 بلا رأس لم يبق متوافقاً');
}
if (!contract.apiVersionAllows(request('v1'), '1')) {
  throw new Error('v1 الصريح لم يُقبل');
}
if (contract.apiVersionAllows(request('2'), '1')) {
  throw new Error('اسم v1 قبل رأس v2');
}
if (contract.apiVersionAllows(request('1, 2'), '1')) {
  throw new Error('قُبل رأس إصدار مركّب');
}
if (!contract.apiVersionAllows(request(undefined), '2')) {
  throw new Error('اسم v2 بلا رأس لم يُقبل');
}
if (!contract.apiVersionAllows(request('2'), '2')) {
  throw new Error('v2 الصريح لم يُقبل');
}
if (contract.apiVersionAllows(request('1'), '2')) {
  throw new Error('اسم v2 قبل رأس v1');
}

// لا توجد وجهة production ضمنية إذا لم تُضبط البيئة صراحةً.
if (contract.subscriptionStatusUrl() !== '') {
  throw new Error('البيئة غير المضبوطة فعّلت وجهة production');
}
if (contract.reportedDeploymentEnvironment() !== 'unconfigured') {
  throw new Error('حالة البيئة غير المضبوطة غير صحيحة');
}
process.env.GCLOUD_PROJECT = 'fatinah-game';
if (contract.subscriptionStatusUrl() !== '') {
  throw new Error('Project ID فعّل production من دون FATINAH_ENVIRONMENT');
}
delete process.env.GCLOUD_PROJECT;

process.env.FATINAH_ENVIRONMENT = 'staging';
process.env.FATINAH_V1_SUBSCRIPTION_STATUS_URL =
  'https://ata20.com/api/subscription/status';
if (contract.validatedSubscriptionStatusUrl() !== null) {
  throw new Error('staging سمح بوجهة اشتراكات production');
}

process.env.FATINAH_V1_SUBSCRIPTION_STATUS_URL =
  'https://api.staging.example.invalid/api/v1/subscription/status?source=test';
let statusUrl = contract.validatedSubscriptionStatusUrl();
if (statusUrl !== null) {
  throw new Error('staging قبل مضيفاً غير موجود في allowlist');
}
process.env.FATINAH_V1_SUBSCRIPTION_ALLOWED_HOSTS =
  'api.staging.example.invalid';
statusUrl = contract.validatedSubscriptionStatusUrl();
if (!statusUrl || statusUrl.hostname !== 'api.staging.example.invalid') {
  throw new Error('رُفضت وجهة staging الآمنة');
}

process.env.FATINAH_ENVIRONMENT = 'prodution';
process.env.FATINAH_V1_SUBSCRIPTION_STATUS_URL =
  'https://ata20.com/api/subscription/status';
if (contract.validatedSubscriptionStatusUrl() !== null) {
  throw new Error('خطأ اسم البيئة فعّل production');
}

process.env.FATINAH_ENVIRONMENT = 'production';
delete process.env.FATINAH_V1_SUBSCRIPTION_STATUS_URL;
delete process.env.FATINAH_V1_SUBSCRIPTION_ALLOWED_HOSTS;
statusUrl = contract.validatedSubscriptionStatusUrl();
if (!statusUrl || statusUrl.hostname !== 'ata20.com') {
  throw new Error('production الصريح لم يحصل على وجهته المتوافقة');
}

process.env.FATINAH_ENVIRONMENT = 'local';
process.env.FATINAH_V1_SUBSCRIPTION_STATUS_URL =
  'http://127.0.0.1:5000/api/v1/subscription/status';
if (!contract.validatedSubscriptionStatusUrl()) {
  throw new Error('وجهة المحاكي المحلي رُفضت');
}
process.env.FATINAH_V1_SUBSCRIPTION_STATUS_URL =
  'https://user:password@api.staging.example.invalid/status';
if (contract.validatedSubscriptionStatusUrl() !== null) {
  throw new Error('قُبلت بيانات اعتماد داخل URL');
}

for (const blocked of [
  '127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.0.1',
  '192.168.1.1', '::1', 'fe80::1', 'fc00::1', '2001:db8::1',
]) {
  if (!networkPolicy.privateOrNonGlobalIp(blocked)) {
    throw new Error(`لم يُرفض IP غير عام: ${blocked}`);
  }
}
if (networkPolicy.privateOrNonGlobalIp('93.184.216.34') ||
    networkPolicy.privateOrNonGlobalIp('2606:4700:4700::1111')) {
  throw new Error('رُفض IP عام');
}

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const privateLookup = async () => [{ address: '169.254.169.254', family: 4 }];
if (!await networkPolicy.resolvesOnlyToPublicIps(
  'nasa.gov', { lookupImpl: publicLookup })) {
  throw new Error('رُفض DNS عام');
}
if (await networkPolicy.resolvesOnlyToPublicIps(
  'nasa.gov', { lookupImpl: privateLookup })) {
  throw new Error('قُبل DNS إلى link-local');
}

function fakeResponse(status, location = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => name.toLowerCase() === 'location' ? location : null },
  };
}

const redirectCalls = [];
const redirectToPrivate = async (url, options) => {
  redirectCalls.push({ url, options });
  return fakeResponse(302, 'http://169.254.169.254/latest/meta-data');
};
let source = await trustedSource.reachableTrustedSource('https://nasa.gov/start', {
  fetchImpl: redirectToPrivate, lookupImpl: publicLookup,
});
if (source !== null || redirectCalls.length !== 1 ||
    redirectCalls[0].options.redirect !== 'manual') {
  throw new Error('تُبعت إعادة توجيه مصدر إلى private أو لم تكن manual');
}

const safeRedirectCalls = [];
const safeRedirect = async (url, options) => {
  safeRedirectCalls.push({ url, options });
  return safeRedirectCalls.length === 1
    ? fakeResponse(302, 'https://www.nasa.gov/final')
    : fakeResponse(200);
};
source = await trustedSource.reachableTrustedSource('https://nasa.gov/start', {
  fetchImpl: safeRedirect, lookupImpl: publicLookup,
});
if (source !== 'https://www.nasa.gov/final' || safeRedirectCalls.length !== 2 ||
    safeRedirectCalls.some((call) => call.options.redirect !== 'manual')) {
  throw new Error('فشل redirect موثوق/manual');
}

let privateFetchCalls = 0;
source = await trustedSource.reachableTrustedSource('https://nasa.gov/start', {
  fetchImpl: async () => { privateFetchCalls += 1; return fakeResponse(200); },
  lookupImpl: privateLookup,
});
if (source !== null || privateFetchCalls !== 0) {
  throw new Error('وصل مصدر ذو DNS خاص إلى fetch');
}

console.log('Cloud Function v1/v2 isolation and environment destinations: passed');
