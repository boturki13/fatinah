---
name: Account deletion ordering
description: قاعدة ترتيب حذف حساب المستخدم بين SQLite وFirestore وFirebase Authentication
---

يجب إبقاء معاملة SQLite مفتوحة وقابلة للتراجع حتى ينجح حذف وثيقة Firestore؛ لا يُعلن نجاح حذف الحساب ولا تُمسح جلسة العميل قبل نجاح النسخة المحلية والسحابية معاً.

**Why:** حذف SQLite أولاً مع فشل Firestore يترك نسخة سحابية قابلة للاستعادة، بينما إعلان نجاح الواجهة عند فشل الخادم يضلل المستخدم ويخالف متطلبات حذف الحساب.

**How to apply:** عند تعديل `/api/account/delete` أو إضافة جدول مرتبط بالمستخدم، أضف الجدول إلى عملية الحذف واختبر حالتي فشل Firestore ونجاحه، مع إبقاء Firebase Authentication كخطوة لاحقة.