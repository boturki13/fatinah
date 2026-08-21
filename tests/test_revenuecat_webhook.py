#!/usr/bin/env python3
"""
اختبار نهاية-لنهاية لـ RevenueCat webhook endpoint.
يشغّل خادم مؤقت على منفذ عشوائي مع سر معروف، ثم يختبر:
  1. EXPIRATION   → status = 'inactive'
  2. CANCELLATION → يبقى status = 'active' حتى EXPIRATION
  3. INITIAL_PURCHASE (uid جديد) → status = 'active' (سجل جديد)
  4. مفتاح خاطئ  → 401
  5. RENEWAL      → status = 'active'
  6. حدث مجهول   → 200 (يُتجاهل)
  7. EXPIRATION webhook → /api/subscription/status يعيد active=false فوراً (بدون تأخير أو كاش)
  8. INITIAL_PURCHASE webhook → /api/subscription/status يعيد active=true فوراً

التشغيل:
    python3 tests/test_revenuecat_webhook.py
"""
import json, os, sqlite3, sys, tempfile, threading, time, urllib.request, urllib.error
from http.server import HTTPServer

# ── بيئة مؤقتة ──────────────────────────────────────────────────────────────
os.environ['REVENUECAT_WEBHOOK_SECRET'] = 'TEST_SECRET_XYZ'
os.environ['FIREBASE_PROJECT_ID']       = ''   # تعطيل Firestore
os.environ['FIREBASE_SERVICE_ACCOUNT_JSON'] = ''
os.environ['GOOGLE_API_KEY']            = ''

# قاعدة بيانات مؤقتة معزولة عن قاعدة الإنتاج
tmp_db = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
tmp_db.close()

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server as srv
srv.DB_PATH = tmp_db.name
srv.init_db()
srv.init_outbox_table()
# لا تعتمد اختبارات الحالة على شبكة Firebase؛ نتحقق من أن نقاط الحالة
# تمرّر رمزاً إلى طبقة التحقق، بينما يظل اختبار الـwebhook نفسه واقعياً.
srv.uid_matches_token = lambda uid, token: bool(uid and token == 'TEST_ID_TOKEN')
_real_firestore_upsert = srv.firestore_upsert_subscription
firestore_calls = []
def recording_firestore_upsert(uid, status, *args, **kwargs):
    firestore_calls.append((uid, status))
    return _real_firestore_upsert(uid, status, *args, **kwargs)
srv.firestore_upsert_subscription = recording_firestore_upsert

# ── تشغيل الخادم على منفذ عشوائي ────────────────────────────────────────────
httpd = HTTPServer(('127.0.0.1', 0), srv.Handler)
port  = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
time.sleep(0.2)

BASE   = f'http://127.0.0.1:{port}'
SECRET = 'TEST_SECRET_XYZ'

# ── دوال مساعدة ─────────────────────────────────────────────────────────────
def post(path, payload, auth=None):
    body = json.dumps(payload).encode()
    req  = urllib.request.Request(
        BASE + path, data=body, method='POST',
        headers={'Content-Type': 'application/json',
                 'Authorization': auth or SECRET})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())

def db_status(uid):
    conn = sqlite3.connect(tmp_db.name)
    row  = conn.execute('SELECT status FROM subscriptions WHERE uid=?', (uid,)).fetchone()
    conn.close()
    return row[0] if row else None

def insert_sub(uid, status):
    conn = sqlite3.connect(tmp_db.name)
    conn.execute(
        "INSERT OR REPLACE INTO subscriptions (uid, status) VALUES (?, ?)",
        (uid, status))
    conn.commit(); conn.close()

def link_identity(uid, rc_app_user_id):
    conn = sqlite3.connect(tmp_db.name)
    conn.execute(
        'INSERT OR REPLACE INTO revenuecat_identities (uid, rc_app_user_id) VALUES (?, ?)',
        (uid, rc_app_user_id))
    conn.commit(); conn.close()

def get(path):
    req = urllib.request.Request(
        BASE + path, method='GET',
        headers={'Authorization': 'Bearer TEST_ID_TOKEN'})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())

def make_event(etype, uid):
    safe_uid = str(uid).replace(':', '_')
    return {'event': {'type': etype, 'id': f'evt_{etype}_{safe_uid}', 'app_user_id': uid}}

RC_EXPIRE = '11111111-1111-4111-8111-111111111111'
RC_CANCEL = '22222222-2222-4222-8222-222222222222'
RC_NEW = '33333333-3333-4333-8333-333333333333'
RC_RENEW = '44444444-4444-4444-8444-444444444444'
RC_EXPIRE_STATUS = '55555555-5555-4555-8555-555555555555'
RC_NEW_STATUS = '66666666-6666-4666-8666-666666666666'

# ── تشغيل الاختبارات ─────────────────────────────────────────────────────────
PASS = '\033[92m✓\033[0m'
FAIL = '\033[91m✗\033[0m'
results = []

def check(name, condition, detail=''):
    icon = PASS if condition else FAIL
    print(f'  {icon} {name}' + (f'  [{detail}]' if detail else ''))
    results.append((name, condition))

print('\n═══ اختبار RevenueCat Webhook (end-to-end) ═══\n')

# 1. مفتاح خاطئ → 401
print('1. مفتاح خاطئ يُرفض')
code, _ = post('/api/revenuecat/webhook',
               make_event('EXPIRATION', 'uid_auth_test'),
               auth='WRONG_KEY')
check('يُرجع 401', code == 401, f'code={code}')
check('لا يستدعي Firestore', not firestore_calls)

# 2. EXPIRATION → inactive
print('\n2. EXPIRATION')
insert_sub('uid_expire', 'active')
link_identity('uid_expire', RC_EXPIRE)
code, _ = post('/api/revenuecat/webhook', make_event('EXPIRATION', RC_EXPIRE))
check('يُرجع 200', code == 200, f'code={code}')
check("status → 'inactive'", db_status('uid_expire') == 'inactive',
      f"status={db_status('uid_expire')}")

# 3. CANCELLATION يوقف التجديد فقط؛ لا يلغي الفترة المدفوعة
print('\n3. CANCELLATION')
insert_sub('uid_cancel', 'active')
link_identity('uid_cancel', RC_CANCEL)
code, _ = post('/api/revenuecat/webhook', make_event('CANCELLATION', RC_CANCEL))
check('يُرجع 200', code == 200, f'code={code}')
check("status يبقى 'active' حتى EXPIRATION", db_status('uid_cancel') == 'active',
      f"status={db_status('uid_cancel')}")

# 3b. BILLING_ISSUE لا يثبت انتهاء الاستحقاق؛ EXPIRATION هو الحد الفاصل
print('\n3b. BILLING_ISSUE')
RC_BILLING = '23232323-2323-4232-8232-232323232323'
insert_sub('uid_billing', 'active')
link_identity('uid_billing', RC_BILLING)
code, _ = post('/api/revenuecat/webhook', make_event('BILLING_ISSUE', RC_BILLING))
check('يُرجع 200', code == 200, f'code={code}')
check("status يبقى 'active' أثناء محاولة استرداد الدفع", db_status('uid_billing') == 'active',
      f"status={db_status('uid_billing')}")

# 4. INITIAL_PURCHASE على uid جديد → ينشئ سجل active
print('\n4. INITIAL_PURCHASE (uid جديد)')
link_identity('uid_new_buyer', RC_NEW)
code, _ = post('/api/revenuecat/webhook', make_event('INITIAL_PURCHASE', RC_NEW))
check('يُرجع 200', code == 200, f'code={code}')
check("سجل جديد بـ status='active'", db_status('uid_new_buyer') == 'active',
      f"status={db_status('uid_new_buyer')}")

# 5. RENEWAL → active
print('\n5. RENEWAL')
insert_sub('uid_renew', 'inactive')
link_identity('uid_renew', RC_RENEW)
code, _ = post('/api/revenuecat/webhook', make_event('RENEWAL', RC_RENEW))
check('يُرجع 200', code == 200, f'code={code}')
check("status → 'active'", db_status('uid_renew') == 'active',
      f"status={db_status('uid_renew')}")

# 6. حدث مجهول → 200 (يُتجاهل)
print('\n6. حدث غير معروف')
code, _ = post('/api/revenuecat/webhook', make_event('UNKNOWN_TYPE', 'uid_unk'))
check('يُرجع 200 (يُتجاهل بأمان)', code == 200, f'code={code}')

# 7. EXPIRATION → /api/subscription/status يعكس active=false فوراً (بدون كاش)
print('\n7. EXPIRATION → /api/subscription/status يعيد active=false فوراً')
insert_sub('uid_expire_status', 'active')
link_identity('uid_expire_status', RC_EXPIRE_STATUS)
post('/api/revenuecat/webhook', make_event('EXPIRATION', RC_EXPIRE_STATUS))
code, resp = get(f'/api/subscription/status?uid=uid_expire_status')
check('يُرجع 200', code == 200, f'code={code}')
check('active=false بعد EXPIRATION مباشرةً', resp.get('active') is False,
      f"active={resp.get('active')}")

# 8. INITIAL_PURCHASE → /api/subscription/status يعكس active=true فوراً
print('\n8. INITIAL_PURCHASE → /api/subscription/status يعيد active=true فوراً')
link_identity('uid_new_status', RC_NEW_STATUS)
post('/api/revenuecat/webhook', make_event('INITIAL_PURCHASE', RC_NEW_STATUS))
code, resp = get(f'/api/subscription/status?uid=uid_new_status')
check('يُرجع 200', code == 200, f'code={code}')
check('active=true بعد INITIAL_PURCHASE مباشرةً', resp.get('active') is True,
      f"active={resp.get('active')}")

# 9. Bearer <secret> مقبول أيضاً (كما قد يُضبط في RevenueCat dashboard)
print('\n9. Authorization: Bearer <secret> مقبول')
RC_BEARER = '77777777-7777-4777-8777-777777777777'
link_identity('uid_bearer', RC_BEARER)
code, _ = post('/api/revenuecat/webhook', make_event('RENEWAL', RC_BEARER),
               auth=f'Bearer {SECRET}')
check('يُرجع 200 مع Bearer', code == 200, f'code={code}')
check("status → 'active'", db_status('uid_bearer') == 'active',
      f"status={db_status('uid_bearer')}")

# 9b. إعادة RevenueCat لنفس event.id لا تعالج الإيصال أو تحدّث الحالة مرتين
print('\n9b. الحدث المكرر يُهمل بأمان')
duplicate_event = {'event': {'type': 'EXPIRATION', 'id': 'evt_duplicate_once',
                             'app_user_id': RC_BEARER}}
code, _ = post('/api/revenuecat/webhook', duplicate_event)
insert_sub('uid_bearer', 'active')
calls_before_duplicate = len(firestore_calls)
code2, duplicate_response = post('/api/revenuecat/webhook', duplicate_event)
check('إعادة الحدث تُرجع 200', code == 200 and code2 == 200)
check('تُعلَّم الاستجابة كمكررة', duplicate_response.get('duplicate') is True)
check('لا تُعاد معالجة الإيصال', db_status('uid_bearer') == 'active' and
      len(firestore_calls) == calls_before_duplicate)

# 9c. event.id إلزامي حتى لا تصبح حماية التكرار قابلة للتجاوز
print('\n9c. event.id المفقود يُرفض')
missing_id = {'event': {'type': 'RENEWAL', 'app_user_id': RC_BEARER}}
code, _ = post('/api/revenuecat/webhook', missing_id)
check('event.id المفقود يُرجع 400', code == 400, f'code={code}')

# 10. UUID غير مربوط بأي حساب → 202 ولا يُنشأ أي سجل (لا وصول)
print('\n10. app_user_id غير مربوط → 202 بلا أي سجل')
RC_ORPHAN = '88888888-8888-4888-8888-888888888888'
calls_before_orphan = len(firestore_calls)
code, _ = post('/api/revenuecat/webhook', make_event('INITIAL_PURCHASE', RC_ORPHAN))
check('يُرجع 202', code == 202, f'code={code}')
conn = sqlite3.connect(tmp_db.name)
orphan_rows = conn.execute('SELECT COUNT(*) FROM subscriptions').fetchone()[0]
conn.close()
check('لم يُنشأ سجل اشتراك جديد', db_status(RC_ORPHAN) is None)
check('لا يستدعي Firestore لهوية غير مربوطة',
      len(firestore_calls) == calls_before_orphan)

# 11. الحل عبر aliases عندما يختلف app_user_id الرئيسي
print('\n11. حلّ الهوية عبر aliases')
RC_ALIAS = '99999999-9999-4999-8999-999999999999'
link_identity('uid_alias', RC_ALIAS)
evt = {'event': {'type': 'RENEWAL', 'id': 'evt_alias',
                 'app_user_id': '$RCAnonymousID:abc123',
                 'aliases': [RC_ALIAS]}}
code, _ = post('/api/revenuecat/webhook', evt)
check('يُرجع 200', code == 200, f'code={code}')
check("status → 'active' عبر alias", db_status('uid_alias') == 'active',
      f"status={db_status('uid_alias')}")

# 12. سر غير مهيَّأ → 503 (fail-closed، لا تحديث أبداً)
print('\n12. TRANSFER ينقل الاستحقاق ولا يتركه على الحساب المصدر')
RC_TRANSFER_FROM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
RC_TRANSFER_TO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
link_identity('uid_transfer_from', RC_TRANSFER_FROM)
link_identity('uid_transfer_to', RC_TRANSFER_TO)
insert_sub('uid_transfer_from', 'active')
insert_sub('uid_transfer_to', 'inactive')
transfer_event = {'event': {
    'type': 'TRANSFER', 'id': 'evt_transfer_accounts',
    'transferred_from': [RC_TRANSFER_FROM],
    'transferred_to': [RC_TRANSFER_TO],
}}
code, response = post('/api/revenuecat/webhook', transfer_event)
check('TRANSFER يُرجع 200', code == 200, f'code={code}')
check('الحساب المصدر يصبح inactive', db_status('uid_transfer_from') == 'inactive')
check('الحساب الوجهة يصبح active', db_status('uid_transfer_to') == 'active')
check('الاستجابة تحدد الوجهة', response.get('uid') == 'uid_transfer_to')

# 13. الاستحقاق المؤقت يُفعّل الوصول إلى أن يرسل RevenueCat حدثه اللاحق
print('\n13. TEMPORARY_ENTITLEMENT_GRANT')
RC_TEMP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
link_identity('uid_temporary', RC_TEMP)
code, _ = post('/api/revenuecat/webhook',
               make_event('TEMPORARY_ENTITLEMENT_GRANT', RC_TEMP))
check('الاستحقاق المؤقت يُرجع 200', code == 200, f'code={code}')
check('الاستحقاق المؤقت يصبح active', db_status('uid_temporary') == 'active')

# 14. سر غير مهيَّأ → 503 (fail-closed، لا تحديث أبداً)
print('\n14. سر webhook غير مهيَّأ → 503')
os.environ['REVENUECAT_WEBHOOK_SECRET'] = ''
code, _ = post('/api/revenuecat/webhook', make_event('RENEWAL', RC_RENEW))
check('يُرجع 503', code == 503, f'code={code}')
os.environ['REVENUECAT_WEBHOOK_SECRET'] = SECRET

# 15. مستخدم منتهي الاشتراك لا يملك وصولاً حتى لو فشل Firestore (SQLite هو المرجع)
print('\n15. لا وصول بعد الانتهاء حتى مع فشل Firestore')
code, resp = get('/api/subscription/status?uid=uid_expire')
check('active=false للاشتراك المنتهي', resp.get('active') is False,
      f"active={resp.get('active')}")

# ── تنظيف وملخص ──────────────────────────────────────────────────────────────
httpd.shutdown()
os.unlink(tmp_db.name)

passed = sum(1 for _, ok in results if ok)
total  = len(results)
print(f'\n══ النتيجة: {passed}/{total} اختبارات نجحت ══\n')

if passed < total:
    print('الاختبارات الفاشلة:')
    for name, ok in results:
        if not ok:
            print(f'  ✗ {name}')
    sys.exit(1)

sys.exit(0)
