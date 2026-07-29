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

def make_event(etype, uid):
    return {'event': {'type': etype, 'id': f'evt_{etype}', 'app_user_id': uid}}

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
code, _ = post('/api/revenuecat/webhook', make_event('EXPIRATION', 'uid_expire'))
check('يُرجع 200', code == 200, f'code={code}')
check("status → 'inactive'", db_status('uid_expire') == 'inactive',
      f"status={db_status('uid_expire')}")

# 3. CANCELLATION → canceled
print('\n3. CANCELLATION')
insert_sub('uid_cancel', 'active')
code, _ = post('/api/revenuecat/webhook', make_event('CANCELLATION', 'uid_cancel'))
check('يُرجع 200', code == 200, f'code={code}')
check("status → 'canceled'", db_status('uid_cancel') == 'canceled',
      f"status={db_status('uid_cancel')}")

# 4. INITIAL_PURCHASE على uid جديد → ينشئ سجل active
print('\n4. INITIAL_PURCHASE (uid جديد)')
code, _ = post('/api/revenuecat/webhook', make_event('INITIAL_PURCHASE', 'uid_new_buyer'))
check('يُرجع 200', code == 200, f'code={code}')
check("سجل جديد بـ status='active'", db_status('uid_new_buyer') == 'active',
      f"status={db_status('uid_new_buyer')}")

# 5. RENEWAL → active
print('\n5. RENEWAL')
insert_sub('uid_renew', 'inactive')
code, _ = post('/api/revenuecat/webhook', make_event('RENEWAL', 'uid_renew'))
check('يُرجع 200', code == 200, f'code={code}')
check("status → 'active'", db_status('uid_renew') == 'active',
      f"status={db_status('uid_renew')}")

# 6. حدث مجهول → 200 (يُتجاهل)
print('\n6. حدث غير معروف')
code, _ = post('/api/revenuecat/webhook', make_event('UNKNOWN_TYPE', 'uid_unk'))
check('يُرجع 200 (يُتجاهل بأمان)', code == 200, f'code={code}')

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
