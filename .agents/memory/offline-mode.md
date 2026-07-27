---
name: Offline mode design
description: How Fatinah works without internet — what's local by design vs. network-only
---
اللعب الأساسي محلي بالتصميم: بنك الأسئلة مضمّن في index.html والفئات العائلية في localStorage — الشيء الوحيد الشبكي أثناء الجلسة هو توليد الأسئلة بالذكاء.

**Why:** أي حلول أوفلاين يجب أن تركّز على توليد الذكاء (مخزون qCache لكل موضوع + تحميل مسبق) وعلى فتح الصفحة نفسها (Service Worker sw.js — يُسجَّل في المتصفح فقط، مُعطَّل على Capacitor لأن الملفات محلية أصلاً).

**How to apply:** sw.js لا يخزّن أبداً مسارات /api/*؛ عند تعديل هيكل التطبيق ارفع رقم CACHE_NAME. مؤشر «وضع دون اتصال» يعتمد على أحداث online/offline.
