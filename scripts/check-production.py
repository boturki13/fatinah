#!/usr/bin/env python3
"""
سكربت فحص متطلبات النشر الإنتاجي لتطبيق فَطِنة.
شغّله قبل الضغط على Deploy للتأكد من اكتمال كل المتطلبات.

الاستخدام:
    python3 scripts/check-production.py
"""
import os, sys, sqlite3, urllib.request, urllib.parse, json

OK  = '✅'
ERR = '❌'
WARN = '⚠️ '

passed = 0
failed = 0
warned = 0

def check(label, condition, fix='', warn=False):
    global passed, failed, warned
    if condition:
        print(f'  {OK}  {label}')
        passed += 1
    elif warn:
        print(f'  {WARN} {label}')
        if fix:
            print(f'       → {fix}')
        warned += 1
    else:
        print(f'  {ERR}  {label}')
        if fix:
            print(f'       → {fix}')
        failed += 1

print()
print('══════════════════════════════════════════════════')
print('   فحص بيئة النشر الإنتاجي — فَطِنة')
print('══════════════════════════════════════════════════')
print()

# ── 1. مفاتيح API الإلزامية ──────────────────────────────────────────────────
print('【١】 مفاتيح API')
required_vars = [
    ('ANTHROPIC_API_KEY',            'توليد الأسئلة بالذكاء الاصطناعي (Claude)'),
    ('GOOGLE_API_KEY',               'التحقق من هوية Firebase'),
    ('FIREBASE_AUTH_DOMAIN',         'تسجيل الدخول Google/Apple'),
    ('FIREBASE_PROJECT_ID',          'تسجيل الدخول Google/Apple'),
    ('FIREBASE_APP_ID',              'تسجيل الدخول Google/Apple'),
    ('FIREBASE_MESSAGING_SENDER_ID', 'تسجيل الدخول Google/Apple'),
    ('FIREBASE_STORAGE_BUCKET',      'تسجيل الدخول Google/Apple'),
    ('RC_API_KEY',                   'RevenueCat — الاشتراكات'),
    ('ADMIN_SECRET',                 'حماية نقاط الأدمن'),
]

for var, desc in required_vars:
    val = os.environ.get(var, '')
    check(
        f'{var:<35} ({desc})',
        bool(val),
        fix=f'أضف "{var}" في Secrets أو .env'
    )

# ── 2. قاعدة البيانات ────────────────────────────────────────────────────────
print()
print('【٢】 قاعدة البيانات')
db_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'subscriptions.db')
db_exists = os.path.exists(db_path)
check('subscriptions.db موجودة', db_exists,
      fix='شغّل python3 server.py مرة واحدة لإنشاء قاعدة البيانات')

if db_exists:
    try:
        conn = sqlite3.connect(db_path)
        tables = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        conn.close()
        expected = {'subscriptions', 'question_bank', 'promo_codes',
                    'promo_redemptions', 'family_categories', 'seen_questions',
                    'player_stats', 'archived_stats'}
        missing = expected - tables
        check('كل جداول قاعدة البيانات موجودة', not missing,
              fix=f'الجداول الناقصة: {missing} — شغّل server.py لإنشائها')
    except Exception as e:
        check('قاعدة البيانات سليمة', False, fix=str(e))

kv_url = os.environ.get('REPLIT_DB_URL', '')
check('REPLIT_DB_URL موجود (KV Backup)', bool(kv_url),
      fix='Replit KV متاح تلقائياً داخل Replit — قد يكون غير مُعيَّن في بيئة محلية',
      warn=True)

# ── 3. رابط الخادم ───────────────────────────────────────────────────────────
print()
print('【٣】 رابط الخادم')
app_url = os.environ.get('REPLIT_APP_URL', '')
domains = os.environ.get('REPLIT_DOMAINS', '')
derived = ''
if not app_url and domains:
    derived = 'https://' + domains.split(',')[0].strip()

check(
    f'REPLIT_APP_URL مضبوط{(" → " + app_url) if app_url else ""}',
    bool(app_url),
    fix=(f'سيُستخدم تلقائياً: {derived}' if derived
         else 'سيُضبط تلقائياً من REPLIT_DOMAINS عند التشغيل'),
    warn=not bool(app_url)
)

if app_url and app_url.endswith('.replit.dev'):
    check('REPLIT_APP_URL رابط إنتاجي (ليس .replit.dev)', False,
          fix='استبدله برابط النشر الرسمي (.replit.app)')
elif app_url:
    check('REPLIT_APP_URL رابط إنتاجي', True)

# ── 4. صحة الخادم (اختياري — يعمل فقط إذا كان الخادم مشغّلاً) ─────────────
print()
print('【٤】 صحة الخادم (فحص سريع)')
port = os.environ.get('PORT', '5000')
try:
    req = urllib.request.Request(
        f'http://127.0.0.1:{port}/firebase-config.js',
        headers={'User-Agent': 'check-production/1.0'})
    with urllib.request.urlopen(req, timeout=3) as resp:
        body = resp.read().decode()
    check('الخادم يستجيب على /firebase-config.js', resp.status == 200)
    check('FIREBASE_CONFIG يظهر في الاستجابة', 'FIREBASE_CONFIG' in body)
    check('FIREBASE_CONFIGURED=true', 'true' in body,
          fix='تأكد من ضبط جميع متغيرات FIREBASE_*',
          warn='false' in body)
except Exception as e:
    check(f'الخادم يستجيب (port {port})', False,
          fix='شغّل python3 server.py أولاً', warn=True)

# ── ملخص ─────────────────────────────────────────────────────────────────────
print()
print('══════════════════════════════════════════════════')
total = passed + failed + warned
print(f'  النتيجة: {passed}/{total} نجح  |  {failed} فشل  |  {warned} تحذير')
print('══════════════════════════════════════════════════')
print()

if failed > 0:
    print(f'  {ERR}  يجب إصلاح {failed} مشكلة قبل النشر.')
    sys.exit(1)
elif warned > 0:
    print(f'  {WARN} البيئة جاهزة مع {warned} تحذير — راجعها قبل النشر.')
    sys.exit(0)
else:
    print(f'  {OK}  كل المتطلبات مكتملة — البيئة جاهزة للنشر!')
    sys.exit(0)
