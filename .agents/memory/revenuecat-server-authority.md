---
name: RevenueCat server authority
description: قاعدة صلاحيات اشتراكات Apple وربط هوية RevenueCat بحساب Firebase
---

الصلاحيات الحساسة لا تعتمد على `CustomerInfo` أو cache من RevenueCat داخل العميل؛ الخادم يفتح المحتوى فقط بعد أن يحدّث webhook موثّق حالة SQLite، مع ربط UUID v4 عشوائي ثابت لكل Firebase UID.

**Why:** حالة العميل قابلة للتأخير أو التلاعب، كما أن استخدام Firebase UID أو البريد كـ`app_user_id` يكشف هوية مباشرة ويصعّب عزل الحسابات.

**How to apply:** عند إضافة شراء أو استعادة أو فحص اشتراك، انتظر تأكيد `/api/stripe/status` الخادمي، وارفض عند فشل الشبكة. لا تعيد توافقاً ينشئ أو يحل هوية RevenueCat من Firebase UID مباشرة.