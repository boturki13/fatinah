# قائمة التحقق: دورة Apple الكاملة عبر TestFlight قبل الإطلاق

آخر تحديث: 31 يوليو 2026

## حالة الجاهزية الخادمية (مُتحقَّق منها آلياً)

| البند | الحالة |
|---|---|
| اختبارات webhook المحلية (`python3 tests/test_revenuecat_webhook.py`) | ✅ 24/24 نجحت |
| السر `REVENUECAT_WEBHOOK_SECRET` موجود في بيئتي التطوير والإنتاج | ✅ |
| `https://ata20.com/api/revenuecat/webhook` يستجيب | ⚠️ يعيد **503** — النسخة المنشورة أقدم من إضافة السر. **يجب إعادة النشر (Republish) أولاً** ثم إعادة الفحص |

بعد إعادة النشر تحقق أن الاستجابة أصبحت **401** (وليس 503) عند طلب بلا سر صحيح:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  https://ata20.com/api/revenuecat/webhook \
  -H "Content-Type: application/json" -d '{}'
# المتوقع: 401
```

## الخطوة 1 — حفظ webhook الإنتاجي في RevenueCat

من **Integrations → Webhooks → New webhook** (التفاصيل الكاملة في `AUTH_SETUP.md` §6):

- URL: `https://ata20.com/api/revenuecat/webhook`
- Authorization header: نفس قيمة `REVENUECAT_WEBHOOK_SECRET`
- Environment: **Production فقط** (شراء TestFlight يُرسل كأحداث Production في RevenueCat)
- الأحداث: `INITIAL_PURCHASE`, `RENEWAL`, `CANCELLATION`, `EXPIRATION`, `BILLING_ISSUE`, `BILLING_ISSUE_RESOLVED`, `PRODUCT_CHANGE`, `UNCANCELLATION`

استخدم **Send test** وراقب استجابة 200 في سجل الـ webhook داخل RevenueCat.

> ملاحظة: حدث الاختبار (TEST) قد يعيد **202** إذا لم يكن `app_user_id` مربوطاً بحساب Firebase — هذا سلوك مقصود وليس خطأ.

## الخطوة 2 — الشراء الأولي من TestFlight

1. سجّل الدخول في التطبيق بحساب Firebase حقيقي (يضمن ربط UUID عبر `/api/revenuecat/identity`).
2. نفّذ الشراء من شاشة الاشتراك (اشتراكات TestFlight تتجدد بسرعة ولا تُحاسَب).
3. تحقق بعد دقيقة:
   - **RevenueCat → Customer → Events**: وصول `INITIAL_PURCHASE` وحالة الـ webhook = 200.
   - **SQLite** على الخادم المنشور:
     ```sql
     SELECT uid, status, updated_at FROM subscriptions ORDER BY updated_at DESC LIMIT 5;
     ```
     المتوقع: `status = 'active'` للـ uid المُختبَر.
   - **Firestore**: وثيقة الاشتراك للـ uid محدّثة بـ `active`.
   - التطبيق يفتح المزايا بعد إعادة فتح الشاشة (الصلاحية خادمية).

## الخطوة 3 — الاستعادة (Restore)

1. احذف التطبيق وأعد تثبيته من TestFlight، أو سجّل الدخول على جهاز آخر بنفس Apple ID وحساب Firebase.
2. اضغط "استعادة المشتريات".
3. تحقق أن المزايا فُتحت وأن أي حدث (`TRANSFER`/`INITIAL_PURCHASE`) وصل بنجاح 200 في سجل RevenueCat.

## الخطوة 4 — التجديد (RENEWAL)

اشتراك TestFlight الشهري يتجدد كل بضع دقائق (حتى 12 تجديداً ثم ينتهي تلقائياً).

- انتظر التجديد الأول وتحقق من وصول `RENEWAL` في RevenueCat بحالة 200.
- تحقق أن `updated_at` في SQLite تغيّر وأن الحالة بقيت `active`.

## الخطوة 5 — الإلغاء/الانتهاء

1. اترك الاشتراك ينتهي (بعد 12 تجديداً في TestFlight) أو ألغِه من إعدادات Sandbox/الاشتراكات.
2. تحقق من وصول `CANCELLATION` ثم `EXPIRATION` في RevenueCat.
3. تحقق أن:
   - SQLite: `status` أصبحت `canceled` ثم `inactive`.
   - `/api/subscription/status` يعيد `active=false` للـ uid فوراً.
   - Firestore محدّث.
   - التطبيق يغلق المزايا ويعرض شاشة الاشتراك.

## الخطوة 6 — التحقق النهائي من السجلات

بعد كل حدث راجع الثلاثية:

1. **RevenueCat** → Webhook delivery log: كلها 200 (أو 202 لهوية غير مربوطة فقط).
2. **SQLite** (`subscriptions` + `webhook_outbox`): لا سجلات outbox معلّقة.
3. **Firestore**: وثيقة الاشتراك مطابقة لحالة SQLite.

إن ظهر أي 401 في سجل RevenueCat فالسر غير متطابق؛ وإن ظهر 503 فالنسخة المنشورة لا تقرأ السر — أعد النشر.
