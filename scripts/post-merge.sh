#!/bin/bash
set -e
# مشروع Python stdlib بدون تبعيات — لا حاجة لتثبيت شيء بعد الدمج
echo "post-merge: nothing to install (Python stdlib project)"

# نظّف روابط Replit الداخلية من package-lock.json حتى لا يفشل npm install على أجهزة المستخدم (Mac)
# الدمج قد يعيد كتابة الروابط إلى http://package-firewall.replit.local/npm/... وهي غير متاحة خارج Replit.
# استبدالها بـ https://registry.npmjs.org/ آمن لأن integrity hashes لا تتأثر.
if [ -f package-lock.json ] && grep -q 'package-firewall\.replit\.local' package-lock.json; then
  sed -i 's|http://package-firewall\.replit\.local/npm/|https://registry.npmjs.org/|g' package-lock.json
  echo "post-merge: cleaned Replit-internal registry URLs from package-lock.json"
fi
