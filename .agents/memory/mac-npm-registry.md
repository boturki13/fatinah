---
name: Mac npm registry
description: قيد تثبيت حزم مشروع iOS خارج بيئة Replit
---

ملف `package-lock.json` الناتج داخل Replit قد يشير إلى سجل تنزيل داخلي لا يمكن الوصول إليه من جهاز Mac. عند تجهيز المشروع خارج Replit، يجب إجبار npm على استخدام `https://registry.npmjs.org` أثناء التثبيت.

**Why:** `npm ci` على Mac يفشل بـ `ENOTFOUND` إذا حاول الوصول إلى نطاق Package Firewall الداخلي، ثم تفشل أوامر Capacitor وCocoaPods بشكل متسلسل لأن `node_modules` لم تُنشأ.

**How to apply:** من جذر المشروع استخدم `npm ci --registry=https://registry.npmjs.org`، ثم `npx cap sync ios` و`pod install`; لا تحذف أو تعدّل قفل الحزم يدوياً لمجرد نقل المشروع بين البيئات.