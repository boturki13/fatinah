---
name: Firestore API requirement
description: متطلب Google Cloud الذي يجب تفعيله قبل أن تعمل مزامنة Firestore عبر REST
---

وجود Service Account صالح لا يكفي؛ يجب تفعيل Cloud Firestore API في نفس المشروع المحدد بـ `FIREBASE_PROJECT_ID` قبل استخدام REST API للقراءة والكتابة.

**Why:** يمكن أن ينجح إصدار OAuth access token ثم يعيد Firestore `403 SERVICE_DISABLED`، ما يبدو ظاهرياً كفشل JWT رغم أن الاعتماد صحيح.

**How to apply:** عند ظهور `Firestore HTTP 403` مع `SERVICE_DISABLED`، فعّل `firestore.googleapis.com` في Google Cloud للمشروع نفسه، انتظر انتشار الإعداد، ثم أعد تشغيل الخادم وتحقق من تفريغ `subscription_outbox`.