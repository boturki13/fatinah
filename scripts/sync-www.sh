#!/usr/bin/env bash
# sync-www.sh — مزامنة مجلد www/ (حزمة iOS/Capacitor) من النسخة الرئيسية.
# يعمل تلقائياً قبل أي `npm run sync` أو `npm run build:ios` (عبر presync/prebuild:ios).
#
# ما يفعله:
#   1. ينسخ index.html و vendor/ إلى www/
#   2. يتحقق من وجود www/firebase-config.js و www/server-config.js
#   3. يحذّر إذا كان SERVER_BASE_URL يشير إلى رابط تطوير مؤقت (*.replit.dev)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> مزامنة www/ من النسخة الرئيسية..."

# 1) نسخ index.html و vendor/
cp index.html www/index.html
rm -rf www/vendor
cp -r vendor www/vendor
echo "    ✓ index.html و vendor/ منسوخان"

# 2) التحقق من ملفات الإعداد الخاصة بحزمة iOS (لا تُنسخ من الجذر — تُدار يدوياً)
MISSING=0
for f in www/firebase-config.js www/server-config.js; do
  if [ ! -f "$f" ]; then
    echo "    ✗ خطأ: $f غير موجود — حزمة iOS لن تعمل بدونه" >&2
    MISSING=1
  fi
done
[ "$MISSING" -eq 1 ] && exit 1

# 3) تحذير إذا كان رابط الخادم رابط تطوير مؤقت
if grep -q 'replit\.dev' www/server-config.js; then
  echo "    ⚠ تحذير: www/server-config.js يشير إلى رابط تطوير مؤقت (*.replit.dev)."
  echo "      قبل شحن الإصدار: استبدله برابط الإنتاج الدائم (*.replit.app)."
fi

# 4) تحقق نهائي: لا فروقات بين النسخة الرئيسية و www/
if ! diff -q index.html www/index.html >/dev/null || ! diff -rq vendor www/vendor >/dev/null; then
  echo "    ✗ خطأ: www/ ما زال غير مطابق بعد النسخ" >&2
  exit 1
fi

echo "==> www/ محدَّث ومطابق للنسخة الرئيسية ✓"
