#!/usr/bin/env python3
"""
اختبار نهاية-لنهاية لـ RevenueCat webhook endpoint.
يشغّل خادم مؤقت على منفذ عشوائي مع سر معروف، ثم يختبر:
  1. EXPIRATION   → status = 'inactive'
  2. CANCELLATION → status = 'canceled'
  3. INITIAL_PURCHASE (uid جديد) → status = 'active' (سجل جديد)
  4. مفتاح خاطئ  → 401
  5. RENEWAL      → status = 'active'
  6. حدث مجهول   → 200 (يُتجاهل)
  7. EXPIRATION webhook → /api/stripe/status يعيد active=false فوراً (بدون تأخير أو كاش)
  8. INITIAL_PURCHASE webhook → /api/stripe/status يعيد active=true فوراً

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
    return {'event': {'type': etype, 'id': f'evt_{etype}', 'app_user_id': uid}}

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

# 2. EXPIRATION → inactive
print('\n2. EXPIRATION')
insert_sub('uid_expire', 'active')
link_identity('uid_expire', RC_EXPIRE)
code, _ = post('/api/revenuecat/webhook', make_event('EXPIRATION', RC_EXPIRE))
check('يُرجع 200', code == 200, f'code={code}')
check("status → 'inactive'", db_status('uid_expire') == 'inactive',
      f"status={db_status('uid_expire')}")

# 3. CANCELLATION → canceled
print('\n3. CANCELLATION')
insert_sub('uid_cancel', 'active')
link_identity('uid_cancel', RC_CANCEL)
code, _ = post('/api/revenuecat/webhook', make_event('CANCELLATION', RC_CANCEL))
check('يُرجع 200', code == 200, f'code={code}')
check("status → 'canceled'", db_status('uid_cancel') == 'canceled',
      f"status={db_status('uid_cancel')}")

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

# 7. EXPIRATION → /api/stripe/status يعكس active=false فوراً (بدون كاش)
print('\n7. EXPIRATION → /api/stripe/status يعيد active=false فوراً')
insert_sub('uid_expire_status', 'active')
link_identity('uid_expire_status', RC_EXPIRE_STATUS)
post('/api/revenuecat/webhook', make_event('EXPIRATION', RC_EXPIRE_STATUS))
code, resp = get(f'/api/stripe/status?uid=uid_expire_status')
check('يُرجع 200', code == 200, f'code={code}')
check('active=false بعد EXPIRATION مباشرةً', resp.get('active') is False,
      f"active={resp.get('active')}")

# 8. INITIAL_PURCHASE → /api/stripe/status يعكس active=true فوراً
print('\n8. INITIAL_PURCHASE → /api/stripe/status يعيد active=true فوراً')
link_identity('uid_new_status', RC_NEW_STATUS)
post('/api/revenuecat/webhook', make_event('INITIAL_PURCHASE', RC_NEW_STATUS))
code, resp = get(f'/api/stripe/status?uid=uid_new_status')
check('يُرجع 200', code == 200, f'code={code}')
check('active=true بعد INITIAL_PURCHASE مباشرةً', resp.get('active') is True,
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
