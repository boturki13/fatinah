---
name: Mac npm registry
description: قيد تثبيت حزم مشروع iOS خارج بيئة Replit
---

ملف `package-lock.json` الناتج داخل Replit قد يشير إلى سجل تنزيل داخلي لا يمكن الوصول إليه من جهاز Mac. عند تجهيز المشروع خارج Replit، يجب إجبار npm على استخدام `https://registry.npmjs.org` أثناء التثبيت.

**Why:** `npm ci` على Mac يفشل بـ `ENOTFOUND` إذا حاول الوصول إلى نطاق Package Firewall الداخلي، ثم تفشل أوامر Capacitor وCocoaPods بشكل متسلسل لأن `node_modules` لم تُنشأ.

**How to apply:** إذا كان القفل يحتوي روابط داخلية، من جذر المشروع استخدم `npm install --package-lock=false --registry=https://registry.npmjs.org`، ثم `npx cap sync ios` و`pod install`; لا تستخدم `npm ci` حتى يُعاد توليد القفل بروابط عامة.