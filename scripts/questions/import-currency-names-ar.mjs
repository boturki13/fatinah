#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUTPUT = path.join(ROOT, 'content/questions/structured-sources/currency-names-ar.json');
const codes = [
  'KWD','SAR','AED','QAR','BHD','OMR','USD','EUR','GBP','JPY',
  'CNY','INR','EGP','IQD','JOD','MAD','DZD','TND','TRY','CAD',
  'AUD','CHF','RUB','KRW','BRL','MXN','PKR','IDR','MYR','SGD',
  'NZD','SEK','NOK','DKK','PLN','CZK','HUF','RON','BGN','ZAR',
  'NGN','KES','ETB','GHS','UGX','TZS','RWF','SDG','LYD','IRR',
  'AFN','BDT','LKR','NPR','THB','VND','PHP','HKD','TWD','MOP',
  'ARS','CLP','COP','PEN','UYU','PYG','BOB','VES','DOP','JMD',
  'TTD','BBD','BSD','BZD','CRC','GTQ','HNL','NIO','PAB','XCD',
  'FJD','PGK','WST','TOP','VUV','MUR','SCR','MVR','KZT','UZS',
];

// CLDR intentionally exposes grammatical forms supplied by locales, but a few
// Arabic entries in the bundled snapshot are awkward as standalone answer
// labels. Keep the upstream value for traceability and apply a small, reviewed
// display-name layer for natural Modern Standard Arabic.
const editorialArabicNames = {
  INR: 'روبية هندية',
  PKR: 'روبية باكستانية',
  NPR: 'روبية نيبالية',
  THB: 'بات تايلاندي',
  KES: 'شلن كيني',
  HNL: 'لمبيرة هندوراسية',
  UYU: 'بيزو أوروغواي',
  DOP: 'بيزو دومينيكاني',
  TTD: 'دولار ترينيداد وتوباغو',
  GTQ: 'كتزال غواتيمالي',
  MVR: 'روفية مالديفية',
};

if (!process.argv.includes('--write')) {
  console.log(`سيولّد ${codes.length} سجلاً من CLDR المثبت في Node.js. استخدم --write للكتابة.`);
  process.exit(0);
}
if (new Set(codes).size !== 90 || codes.some(code => !/^[A-Z]{3}$/u.test(code))) {
  throw new Error('قائمة رموز العملات يجب أن تحتوي 90 رمزاً متمايزاً.');
}
const supported = new Set(Intl.supportedValuesOf('currency'));
const displayNames = new Intl.DisplayNames(['ar'], { type: 'currency', fallback: 'none' });
const records = codes.map((code, familiarityRank) => {
  const cldrNameAr = displayNames.of(code);
  if (!supported.has(code) || !cldrNameAr || cldrNameAr === code) throw new Error(`رمز عملة غير مدعوم: ${code}`);
  return {
    sourceRecordId: `cldr-currency-${code.toLowerCase()}`,
    code,
    nameAr: editorialArabicNames[code] || cldrNameAr,
    cldrNameAr,
    familiarityRank: familiarityRank + 1,
    // Versioned locale summary is the official CLDR page containing the
    // Arabic currency-name rows. The former synthetic by_type filename 404s.
    sourceUrl: `https://www.unicode.org/cldr/charts/${process.versions.cldr.split('.')[0]}/summary/ar.html`,
    sourcePublisher: 'Unicode Consortium — CLDR',
  };
});
const document = {
  schemaVersion: 1,
  sourceProfile: 'cldr_currency_names_v1',
  cldrVersion: process.versions.cldr,
  generatedWithNode: process.version,
  selectionPolicy: '90 explicitly ranked current ISO-style currency codes; prohibited topic excluded; reviewed Arabic display overrides retained alongside original CLDR labels',
  records,
};
fs.writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
console.log(`كُتب ${records.length} سجل عملة مثبّت إلى ${path.relative(ROOT, OUTPUT)}`);
