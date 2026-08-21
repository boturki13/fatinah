"""
خادم فطنة — Python خفيف مع Firebase Admin للتحقق المحلي من الرموز.
يخدم index.html وfirebase-config.js ويدير اشتراكات Apple IAP عبر RevenueCat.
أسئلة اللعبة تصدر من بنك محتوى ثابت ومراجع؛ لا يوجد توليد آلي للمستخدم.
"""
import gzip, hashlib, json, os, sqlite3, threading, time, urllib.request, urllib.error, urllib.parse, uuid
import smtplib, ssl
from email.message import EmailMessage
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
import re

# ─── ثوابت ─────────────────────────────────────────────────────────────────
PORT      = int(os.environ.get('PORT', 5000))
WWW_DIR   = os.path.join(os.path.dirname(__file__), 'www')
HTML_FILE = os.path.join(WWW_DIR, 'index.html')
DB_PATH   = os.path.join(os.path.dirname(__file__), 'subscriptions.db')

def firestore_database_name():
    """اسم قاعدة Firestore بصيغة REST، مع دعم default القديم."""
    database_id = os.environ.get('FIRESTORE_DATABASE_ID', 'default').strip()
    if not database_id or database_id == 'default':
        return '(default)'
    return database_id

def firestore_database_path():
    return urllib.parse.quote(firestore_database_name(), safe='()')

# ─── قاعدة البيانات ──────────────────────────────────────────────────────────
def db_connect():
    """اتصال sqlite آمن للخيوط المتعددة: WAL + مهلة انتظار للأقفال."""
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA busy_timeout=10000')
    return conn

def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute('''
        CREATE TABLE IF NOT EXISTS subscriptions (
            uid                    TEXT PRIMARY KEY,
            email                  TEXT,
            stripe_customer_id     TEXT,
            stripe_subscription_id TEXT,
            status                 TEXT DEFAULT 'inactive',
            updated_at             DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    # ─── هجرة: أعمدة الهوية الموحّدة (اسم العرض + آخر مزوّد دخول) ─────────────
    # sqlite لا يدعم ADD COLUMN IF NOT EXISTS، فنجرّب ونتجاهل الخطأ إن كان العمود موجوداً
    for ddl in (
        "ALTER TABLE subscriptions ADD COLUMN display_name TEXT",
        "ALTER TABLE subscriptions ADD COLUMN auth_provider TEXT",
        "ALTER TABLE subscriptions ADD COLUMN expires_at DATETIME",
    ):
        try: conn.execute(ddl)
        except sqlite3.OperationalError: pass  # العمود موجود مسبقاً
    conn.execute('''
        CREATE TABLE IF NOT EXISTS question_bank (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            topic_norm TEXT NOT NULL,
            q          TEXT NOT NULL,
            answer     TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(topic_norm, q)
        )
    ''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_bank_topic ON question_bank(topic_norm)')
    # سجل مركزي للأسئلة التي شاهدها كل حساب. يبقى منفصلاً عن بنك المحتوى
    # حتى تتمكن الأجهزة المختلفة للحساب نفسه من منع التكرار دون تخزين نصوص
    # الأسئلة أو أي بيانات شخصية إضافية.
    conn.execute('''
        CREATE TABLE IF NOT EXISTS question_seen (
            uid         TEXT NOT NULL,
            question_id TEXT NOT NULL,
            category    TEXT NOT NULL,
            seen_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (uid, question_id)
        )
    ''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_question_seen_uid_time ON question_seen(uid, seen_at)')
    # جولة تعريفية واحدة لكل حساب. تسجيل الإكمال في الخادم يمنع إعادة فتحها
    # بمجرد مسح تخزين التطبيق أو الانتقال إلى جهاز آخر.
    conn.execute('''
        CREATE TABLE IF NOT EXISTS free_rounds (
            uid          TEXT PRIMARY KEY,
            completed_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    # البلاغ يُحفظ قبل محاولة البريد، فلا يضيع بسبب تعطل مزوّد SMTP. عامل
    # الخلفية يعيد إرسال pending/failed بعد إعداد أسرار البريد في الخادم.
    conn.execute('''
        CREATE TABLE IF NOT EXISTS question_reports (
            report_id     TEXT PRIMARY KEY,
            uid           TEXT NOT NULL,
            question_id   TEXT NOT NULL,
            category      TEXT NOT NULL,
            question_text TEXT NOT NULL,
            answer_text   TEXT,
            reason        TEXT NOT NULL,
            details       TEXT,
            app_version   TEXT,
            email_status  TEXT DEFAULT 'pending',
            email_error   TEXT,
            email_attempts INTEGER DEFAULT 0,
            created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
            emailed_at    DATETIME
        )
    ''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_question_reports_status ON question_reports(email_status, created_at)')
    # قياسات منتج محدودة ومقيدة بقائمة أحداث؛ لا نخزن نص السؤال أو البريد.
    conn.execute('''
        CREATE TABLE IF NOT EXISTS game_events (
            event_id    TEXT PRIMARY KEY,
            uid         TEXT NOT NULL,
            event_name  TEXT NOT NULL,
            properties  TEXT NOT NULL DEFAULT '{}',
            app_version TEXT,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_game_events_name_time ON game_events(event_name, created_at)')
    # ─── جدول outbox لإعادة الكتابة إلى Firestore عند الفشل ────────────────────
    conn.execute('''
        CREATE TABLE IF NOT EXISTS subscription_outbox (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            uid         TEXT NOT NULL,
            payload     TEXT NOT NULL,
            attempts    INTEGER DEFAULT 0,
            last_error  TEXT,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
            next_retry  DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    # لا نستخدم Firebase UID أو البريد كـ RevenueCat app_user_id.
    # هذا الربط الداخلي يسمح للـ webhook بتحويل UUID العشوائي إلى حساب Firebase
    # من دون كشف أي معرّف مباشر في RevenueCat.
    conn.execute('''
        CREATE TABLE IF NOT EXISTS revenuecat_identities (
            uid            TEXT PRIMARY KEY,
            rc_app_user_id TEXT NOT NULL UNIQUE,
            created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS revenuecat_events (
            event_id     TEXT PRIMARY KEY,
            event_type   TEXT NOT NULL,
            uid          TEXT NOT NULL,
            processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    # حقول صندوق الوارد الدائم للـwebhook. تبقى الأعمدة اختيارية أثناء
    # الترقية حتى تظل قواعد البيانات المنشأة بالإصدارات السابقة قابلة للفتح.
    for ddl in (
        "ALTER TABLE revenuecat_events ADD COLUMN status TEXT DEFAULT 'processed'",
        "ALTER TABLE revenuecat_events ADD COLUMN payload TEXT",
        "ALTER TABLE revenuecat_events ADD COLUMN rc_ids TEXT",
    ):
        try: conn.execute(ddl)
        except sqlite3.OperationalError: pass
    conn.execute('''
        CREATE TABLE IF NOT EXISTS ios_diagnostics (
            report_id   TEXT PRIMARY KEY,
            uid         TEXT NOT NULL,
            report_type TEXT NOT NULL,
            payload     TEXT NOT NULL,
            app_version TEXT,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_ios_diagnostics_uid_time ON ios_diagnostics(uid, created_at)')
    conn.commit()
    conn.close()

def normalize_topic(topic: str) -> str:
    """توحيد الموضوع: إزالة التشكيل والمسافات الزائدة وأل التعريف للمطابقة."""
    import re
    t = topic.strip().lower()
    t = re.sub(r'[\u064B-\u0652\u0670]', '', t)          # تشكيل
    t = t.replace('أ', 'ا').replace('إ', 'ا').replace('آ', 'ا').replace('ة', 'ه').replace('ى', 'ي')
    t = re.sub(r'\s+', ' ', t)
    return t

# ─── التحقق من هوية Firebase (نظام الهوية الموحّد — Task #70) ───────────────
# نتحقق من صحة idToken عبر Identity Toolkit REST API بدل الثقة العمياء بالـ uid
# القادم من العميل. هذا بديل مكافئ لـ Firestore Security Rules طالما نبقى على
# SQLite. إن كان Firebase غير مُعدّ في البيئة (بلا FIREBASE_PROJECT_ID) نتراجع
# لسلوك الثقة بالـ uid كما كان سابقاً (بيئة تطوير محلية بلا Firebase).
def firebase_is_configured() -> bool:
    return bool(os.environ.get('FIREBASE_PROJECT_ID'))

def verify_firebase_id_token(id_token: str):
    """يتحقق محلياً عبر Admin SDK، مع REST كمسار توافق مؤقت."""
    if os.environ.get('FIREBASE_SERVICE_ACCOUNT_JSON', '').strip() and id_token:
        try:
            from firebase_admin_bridge import verify_id_token
            decoded = verify_id_token(id_token)
            # نحافظ على شكل Identity Toolkit كي لا تتغير بقية طبقة الخادم.
            return {
                'localId': decoded.get('uid') or decoded.get('sub'),
                'email': decoded.get('email'),
            }
        except Exception as e:
            print(f'Admin ID token verify error: {e}')
            return None
    api_key = os.environ.get('GOOGLE_API_KEY', '')
    if not api_key or not id_token:
        return None
    try:
        payload = json.dumps({'idToken': id_token}).encode()
        req = urllib.request.Request(
            f'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key={api_key}',
            data=payload, method='POST',
            headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        users = data.get('users') or []
        return users[0] if users else None
    except Exception as e:
        print(f'ID token verify error: {e}')
        return None

def uid_matches_token(uid: str, id_token: str) -> bool:
    """يتحقق أن uid المطلوب هو نفس صاحب idToken المرسَل. رفض افتراضي
    (deny-by-default) في أي حالة تعذّر فيها التحقق الفعلي. عند تهيئة
    Firebase Admin لا نحتاج GOOGLE_API_KEY؛ يُستخدم المفتاح العام فقط لمسار
    REST التوافقي عندما لا يتوفر مفتاح الخدمة. القبول بلا تحقق كان يعني أن
    أي طلب بـuid عشوائي يمرّ من كل نقطة نهاية "محمية"."""
    if not firebase_is_configured():
        print('WARNING: FIREBASE_PROJECT_ID غير مضبوط — رفض التحقق من الهوية (deny-by-default)')
        return False
    if not id_token:
        return False
    admin_configured = bool(
        os.environ.get('FIREBASE_SERVICE_ACCOUNT_JSON', '').strip()
    )
    if not admin_configured and not os.environ.get('GOOGLE_API_KEY', '').strip():
        print('WARNING: GOOGLE_API_KEY غير مضبوط — رفض التحقق من الهوية (deny-by-default)')
        return False
    verified = verify_firebase_id_token(id_token)
    return bool(verified and verified.get('localId') == uid)

APP_CHECK_PROTECTED_PATHS = {
    '/api/account/delete', '/api/account/profile',
    '/api/free-round/complete', '/api/free-round/status',
    '/api/questions/seen', '/api/questions/report',
    '/api/metrics/event', '/api/ios-diagnostics',
    '/api/revenuecat/identity', '/api/subscription/status',
}

def app_check_enforcement_enabled() -> bool:
    return os.environ.get('FIREBASE_APP_CHECK_ENFORCE', '').strip().lower() in (
        '1', 'true', 'yes', 'enforce'
    )

def verify_app_check_header(headers, path: str):
    """يعيد (valid, reason). وضع المراقبة يسجل فقط؛ الإنفاذ متغير بيئة."""
    if path not in APP_CHECK_PROTECTED_PATHS:
        return True, 'not_required'
    token = (headers.get('X-Firebase-AppCheck', '') or '').strip()
    if not token:
        return False, 'missing'
    if not os.environ.get('FIREBASE_SERVICE_ACCOUNT_JSON', '').strip():
        return False, 'admin_not_configured'
    try:
        from firebase_admin_bridge import verify_app_check_token
        verify_app_check_token(token)
        return True, 'verified'
    except Exception as exc:
        print(f'[App Check] verification failed path={path}: {exc}')
        return False, 'invalid'

def is_valid_rc_app_user_id(value: str) -> bool:
    """نقبل UUID canonical فقط حتى لا يعود أي مسار لاستخدام UID/email مباشرة."""
    return bool(re.fullmatch(
        r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',
        (value or '').strip().lower()))

def subscription_is_active(uid: str) -> bool:
    """حالة صلاحيات خادمية مصدرها Apple/RevenueCat فقط.

    CANCELLATION يعني إيقاف التجديد، وليس انتهاء الفترة المدفوعة. لذلك تبقى
    الحالة فعالة حتى EXPIRATION، ونستخدم expires_at كحارس إضافي إذا تأخر الحدث.
    """
    if not uid:
        return False
    conn = db_connect()
    try:
        row = conn.execute(
            'SELECT status, expires_at FROM subscriptions WHERE uid=?',
            (uid,)).fetchone()
        if not row:
            return False
        status, expires_at = row
        if status != 'active':
            return False
        if expires_at and not conn.execute(
                "SELECT 1 WHERE ? > datetime('now')", (expires_at,)).fetchone():
            conn.execute(
                "UPDATE subscriptions SET status='inactive', updated_at=CURRENT_TIMESTAMP "
                "WHERE uid=? AND status='active'", (uid,))
            conn.commit()
            return False
        return True
    finally:
        conn.close()

def bearer_token(headers) -> str:
    """يستخرج ID token من رأس Authorization: Bearer <token> (لنقاط GET)."""
    auth = headers.get('Authorization', '') or ''
    if auth.startswith('Bearer '):
        return auth[len('Bearer '):].strip()
    return ''

# ─── حد معدل بسيط في الذاكرة لكل IP (يمنع brute-force لأكواد المكافأة) ────────
_rate_lock    = threading.Lock()
_rate_buckets = {}   # key -> list[timestamps]

def rate_limited(key: str, max_calls: int, window_sec: int) -> bool:
    """يعيد True إن تجاوز المفتاح الحد المسموح خلال النافذة الزمنية."""
    now = time.time()
    with _rate_lock:
        bucket = [t for t in _rate_buckets.get(key, []) if now - t < window_sec]
        if len(bucket) >= max_calls:
            _rate_buckets[key] = bucket
            return True
        bucket.append(now)
        _rate_buckets[key] = bucket
        # تنظيف دوري خفيف لمنع تضخم الذاكرة
        if len(_rate_buckets) > 10000:
            for k in [k for k, v in _rate_buckets.items() if not v or now - v[-1] > window_sec]:
                _rate_buckets.pop(k, None)
    return False

REPORT_EMAIL_TO = 'ata@ata20.com'
REPORT_REASONS = {
    'incorrect_answer': 'الإجابة غير صحيحة',
    'unclear': 'السؤال غير واضح',
    'outdated': 'المعلومة قديمة',
    'source': 'مشكلة في المصدر',
    'duplicate': 'السؤال مكرر',
    'other': 'سبب آخر',
}
METRIC_EVENTS = {
    'game_started', 'game_completed', 'free_round_completed',
    'paywall_viewed', 'offer_code_opened', 'question_reported',
    'purchase_started', 'purchase_completed', 'restore_started',
}
METRIC_PROPERTY_SCHEMAS = {
    'game_started': {
        'difficulty', 'teams', 'categoryCount', 'freeRound', 'familyRound',
    },
    'game_completed': {
        'difficulty', 'teams', 'categoryCount', 'questions', 'correct',
        'incorrect', 'durationSeconds', 'topScore', 'tie', 'freeRound',
    },
    'free_round_completed': {'questions'},
    'paywall_viewed': {'freeRoundCompleted'},
    'offer_code_opened': set(),
    'question_reported': {'reason'},
    'purchase_started': {'plan'},
    'purchase_completed': {'plan'},
    'restore_started': set(),
}

def metric_properties_are_safe(event_name: str, properties: dict) -> bool:
    """مخطط مغلق يمنع تسرب بريد/اسم/token/نص سؤال إلى القياسات."""
    allowed = METRIC_PROPERTY_SCHEMAS.get(event_name)
    if allowed is None or set(properties) - allowed:
        return False
    for key, value in properties.items():
        if key in {'freeRound', 'familyRound', 'tie', 'freeRoundCompleted'}:
            if not isinstance(value, bool):
                return False
        elif key == 'difficulty':
            if value not in {'easy', 'normal', 'hard'}:
                return False
        elif key == 'plan':
            if value not in {'monthly', 'annual'}:
                return False
        elif key == 'reason':
            if value not in REPORT_REASONS:
                return False
        elif key in {'teams', 'categoryCount', 'questions', 'correct',
                     'incorrect', 'durationSeconds', 'topScore'}:
            if not isinstance(value, int) or isinstance(value, bool):
                return False
            minimum, maximum = {
                'teams': (2, 3),
                'categoryCount': (1, 20),
                'questions': (0, 200),
                'correct': (0, 200),
                'incorrect': (0, 200),
                'durationSeconds': (0, 86_400),
                'topScore': (-100_000, 100_000),
            }[key]
            if not minimum <= value <= maximum:
                return False
        else:
            return False
    return True

def _send_question_report_email(row) -> str:
    """أرسل بلاغاً محفوظاً عبر SMTP. لا يوجد أي سر داخل تطبيق iOS."""
    (report_id, _uid, question_id, category, question_text, answer_text,
     reason, details, app_version, _created_at) = row
    host = os.environ.get('SMTP_HOST', '').strip()
    from_address = os.environ.get('SMTP_FROM', '').strip()
    if not host or not from_address:
        return 'pending_configuration'
    to_address = os.environ.get('REPORT_EMAIL_TO', REPORT_EMAIL_TO).strip() or REPORT_EMAIL_TO
    port = int(os.environ.get('SMTP_PORT', '587'))
    username = os.environ.get('SMTP_USERNAME', '').strip()
    password = os.environ.get('SMTP_PASSWORD', '')
    use_ssl = os.environ.get('SMTP_USE_SSL', '').lower() in ('1', 'true', 'yes')
    use_tls = os.environ.get('SMTP_USE_TLS', 'true').lower() not in ('0', 'false', 'no')

    message = EmailMessage()
    message['From'] = from_address
    message['To'] = to_address
    message['Subject'] = f'[فطنة] بلاغ سؤال — {category}'
    message.set_content(
        'ورد بلاغ جديد من تطبيق فطنة.\n\n'
        f'رقم البلاغ: {report_id}\n'
        f'معرف السؤال: {question_id}\n'
        f'الفئة: {category}\n'
        f'السبب: {REPORT_REASONS.get(reason, reason)}\n'
        f'التفاصيل: {details or "—"}\n'
        f'السؤال: {question_text}\n'
        f'الإجابة الحالية: {answer_text or "—"}\n'
        f'إصدار التطبيق: {app_version or "—"}\n'
    )
    context = ssl.create_default_context()
    if use_ssl:
        client = smtplib.SMTP_SSL(host, port, timeout=12, context=context)
    else:
        client = smtplib.SMTP(host, port, timeout=12)
    try:
        if not use_ssl and use_tls:
            client.starttls(context=context)
        if username:
            client.login(username, password)
        client.send_message(message)
    finally:
        try: client.quit()
        except Exception: client.close()
    return 'sent'

def deliver_pending_question_reports(limit: int = 20) -> int:
    """يحاول تسليم البلاغات غير المرسلة ويحدّث حالتها دون فقدها."""
    conn = db_connect()
    status_updates = []
    delivered = 0
    try:
        rows = conn.execute('''
            SELECT report_id, uid, question_id, category, question_text,
                   answer_text, reason, details, app_version, created_at
            FROM question_reports
            WHERE email_status IN ('pending','failed','pending_configuration')
              AND email_attempts < 20
            ORDER BY created_at LIMIT ?
        ''', (limit,)).fetchall()
        for row in rows:
            try:
                status = _send_question_report_email(row)
                conn.execute('''
                    UPDATE question_reports
                    SET email_status=?, email_error=NULL,
                        email_attempts=email_attempts+1,
                        emailed_at=CASE WHEN ?='sent' THEN CURRENT_TIMESTAMP ELSE emailed_at END
                    WHERE report_id=?
                ''', (status, status, row[0]))
                status_updates.append((row[0], status, None))
                delivered += int(status == 'sent')
            except Exception as exc:
                conn.execute('''
                    UPDATE question_reports
                    SET email_status='failed', email_error=?,
                        email_attempts=email_attempts+1
                    WHERE report_id=?
                ''', (str(exc)[:500], row[0]))
                status_updates.append((row[0], 'failed', str(exc)[:500]))
        conn.commit()
    finally:
        conn.close()
    if firestore_durable_available():
        for report_id, status, error in status_updates:
            try:
                firestore_set_document(f'question_reports/{report_id}', {
                    'email_status': status,
                    'email_error': error,
                    'email_updated_at': time.strftime(
                        '%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                })
            except Exception as exc:
                print(f'[Question Reports] Firestore status sync failed {report_id}: {exc}')
    return delivered

def _question_report_email_worker():
    while True:
        time.sleep(60)
        try: deliver_pending_question_reports()
        except Exception as exc: print(f'[Question Reports] retry error: {exc}')
def get_revenuecat_secret():
    """مفتاح تحقق ويبهوك RevenueCat — يُقارَن مع رأس Authorization الوارد."""
    return os.environ.get('REVENUECAT_WEBHOOK_SECRET', '')

# ─── Google Service Account → OAuth2 access token (RS256 JWT) ────────────────
_gsa_token_cache = {'token': None, 'exp': 0}

def _get_gsa_access_token(sa_json: dict) -> str:
    """
    يُنشئ JWT موقَّع بـ RS256 ويُبادله بـ OAuth2 access token من Google.
    النتيجة مُخزَّنة محلياً لمدة دقيقة أقل من انتهاء صلاحيتها.
    """
    import time as _time, base64, struct
    from cryptography.hazmat.primitives import serialization, hashes
    from cryptography.hazmat.primitives.asymmetric import padding as _padding
    from cryptography.hazmat.backends import default_backend

    now = int(_time.time())
    if _gsa_token_cache['token'] and now < _gsa_token_cache['exp']:
        return _gsa_token_cache['token']

    private_key_pem = sa_json['private_key'].encode()
    client_email    = sa_json['client_email']
    scope           = 'https://www.googleapis.com/auth/datastore'
    token_uri       = sa_json.get('token_uri', 'https://oauth2.googleapis.com/token')

    # ── بناء JWT ────────────────────────────────────────────────────────────
    def b64url(data: bytes) -> str:
        return base64.urlsafe_b64encode(data).rstrip(b'=').decode()

    header  = b64url(json.dumps({'alg': 'RS256', 'typ': 'JWT'}).encode())
    payload = b64url(json.dumps({
        'iss': client_email,
        'sub': client_email,
        'aud': token_uri,
        'scope': scope,
        'iat': now,
        'exp': now + 3600,
    }).encode())
    signing_input = f'{header}.{payload}'.encode()

    private_key = serialization.load_pem_private_key(
        private_key_pem, password=None, backend=default_backend())
    signature = private_key.sign(signing_input, _padding.PKCS1v15(), hashes.SHA256())
    jwt_token = f'{header}.{payload}.{b64url(signature)}'

    # ── تبادل JWT بـ access token ────────────────────────────────────────────
    data = urllib.parse.urlencode({
        'grant_type': 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        'assertion':  jwt_token,
    }).encode()
    req = urllib.request.Request(token_uri, data=data,
          headers={'Content-Type': 'application/x-www-form-urlencoded'})
    with urllib.request.urlopen(req, timeout=10) as resp:
        result = json.loads(resp.read())

    token = result['access_token']
    _gsa_token_cache['token'] = token
    _gsa_token_cache['exp']   = now + int(result.get('expires_in', 3600)) - 60
    return token

# ─── Firestore REST: مخزن دائم عام ──────────────────────────────────────────
def firestore_durable_available() -> bool:
    """هل تتوفر بيانات اعتماد كتابة Firestore في هذه العملية؟"""
    return bool(
        os.environ.get('FIREBASE_PROJECT_ID', '').strip()
        and os.environ.get('FIREBASE_SERVICE_ACCOUNT_JSON', '').strip()
    )

def durable_storage_required() -> bool:
    """يفشل مغلقاً في النشر، مع إبقاء الاختبارات والتطوير المحلي بلا شبكة.

    يمكن ضبط FATINAH_DURABLE_STORAGE صراحةً إلى required/optional/off. في
    Replit Deployment نختار required افتراضياً لأن قرص النشر غير دائم.
    """
    configured = os.environ.get('FATINAH_DURABLE_STORAGE', '').strip().lower()
    if configured:
        return configured == 'required'
    return os.environ.get('REPLIT_DEPLOYMENT', '').strip().lower() in (
        '1', 'true', 'yes', 'production'
    )

def _firestore_credentials():
    project_id = os.environ.get('FIREBASE_PROJECT_ID', '').strip()
    sa_json_str = os.environ.get('FIREBASE_SERVICE_ACCOUNT_JSON', '').strip()
    if not project_id or not sa_json_str:
        raise RuntimeError('FIREBASE_PROJECT_ID أو FIREBASE_SERVICE_ACCOUNT_JSON غير محدد')
    return project_id, _get_gsa_access_token(json.loads(sa_json_str))

def _firestore_value(value):
    if value is None:
        return {'nullValue': None}
    if isinstance(value, bool):
        return {'booleanValue': value}
    if isinstance(value, int) and not isinstance(value, bool):
        return {'integerValue': str(value)}
    if isinstance(value, float):
        return {'doubleValue': value}
    if isinstance(value, list):
        return {'arrayValue': {'values': [_firestore_value(item) for item in value]}}
    if isinstance(value, dict):
        return {'mapValue': {'fields': {
            str(key): _firestore_value(item) for key, item in value.items()
        }}}
    return {'stringValue': str(value)}

def _firestore_decode_value(value):
    if 'nullValue' in value:
        return None
    if 'booleanValue' in value:
        return bool(value['booleanValue'])
    if 'integerValue' in value:
        return int(value['integerValue'])
    if 'doubleValue' in value:
        return float(value['doubleValue'])
    if 'timestampValue' in value:
        return value['timestampValue']
    if 'stringValue' in value:
        return value['stringValue']
    if 'arrayValue' in value:
        return [_firestore_decode_value(item) for item in
                (value['arrayValue'].get('values') or [])]
    if 'mapValue' in value:
        return {
            key: _firestore_decode_value(item)
            for key, item in (value['mapValue'].get('fields') or {}).items()
        }
    return None

def _firestore_decode_document(document):
    result = {
        key: _firestore_decode_value(value)
        for key, value in (document.get('fields') or {}).items()
    }
    result['_document_id'] = (document.get('name') or '').rsplit('/', 1)[-1]
    return result

def _firestore_document_url(project_id: str, document_path: str) -> str:
    clean_path = '/'.join(
        urllib.parse.quote(segment, safe='')
        for segment in document_path.strip('/').split('/')
    )
    return (
        f'https://firestore.googleapis.com/v1/projects/{project_id}'
        f'/databases/{firestore_database_path()}/documents/{clean_path}'
    )

def firestore_get_document(document_path: str):
    project_id, token = _firestore_credentials()
    req = urllib.request.Request(
        _firestore_document_url(project_id, document_path),
        headers={'Authorization': f'Bearer {token}'},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            return _firestore_decode_document(json.loads(response.read()))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise RuntimeError(_firestore_http_error(exc, f'get {document_path}')) from exc

def firestore_set_document(document_path: str, data: dict, *, merge: bool = True):
    project_id, token = _firestore_credentials()
    fields = {str(key): _firestore_value(value) for key, value in data.items()}
    url = _firestore_document_url(project_id, document_path)
    if merge and fields:
        query = urllib.parse.urlencode(
            [('updateMask.fieldPaths', key) for key in fields], doseq=True)
        url += f'?{query}'
    req = urllib.request.Request(
        url,
        data=json.dumps({'fields': fields}, ensure_ascii=False).encode(),
        method='PATCH',
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json; charset=utf-8',
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            return _firestore_decode_document(json.loads(response.read()))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(_firestore_http_error(exc, f'set {document_path}')) from exc

def firestore_delete_document(document_path: str):
    project_id, token = _firestore_credentials()
    req = urllib.request.Request(
        _firestore_document_url(project_id, document_path),
        method='DELETE',
        headers={'Authorization': f'Bearer {token}'},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            response.read()
    except urllib.error.HTTPError as exc:
        if exc.code != 404:
            raise RuntimeError(_firestore_http_error(exc, f'delete {document_path}')) from exc

def firestore_list_documents(collection_path: str, *, page_size: int = 1000):
    project_id, token = _firestore_credentials()
    documents = []
    page_token = ''
    while True:
        query = {'pageSize': max(1, min(page_size, 1000))}
        if page_token:
            query['pageToken'] = page_token
        url = _firestore_document_url(project_id, collection_path)
        url += '?' + urllib.parse.urlencode(query)
        req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                payload = json.loads(response.read())
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return []
            raise RuntimeError(_firestore_http_error(exc, f'list {collection_path}')) from exc
        documents.extend(_firestore_decode_document(doc) for doc in
                         (payload.get('documents') or []))
        page_token = payload.get('nextPageToken') or ''
        if not page_token:
            return documents

def firestore_query_documents(collection_id: str, field_path: str, value,
                              *, op: str = 'EQUAL'):
    """استعلام حقل بسيط لاسترجاع/حذف سجلات مستخدم بعينه."""
    if op not in {'EQUAL', 'ARRAY_CONTAINS'}:
        raise ValueError('Firestore query operator غير مسموح')
    project_id, token = _firestore_credentials()
    url = (
        f'https://firestore.googleapis.com/v1/projects/{project_id}'
        f'/databases/{firestore_database_path()}/documents:runQuery'
    )
    body = {
        'structuredQuery': {
            'from': [{'collectionId': collection_id}],
            'where': {'fieldFilter': {
                'field': {'fieldPath': field_path},
                'op': op,
                'value': _firestore_value(value),
            }},
            'limit': 10000,
        }
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode(),
        method='POST',
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json; charset=utf-8',
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as response:
            payload = json.loads(response.read())
    except urllib.error.HTTPError as exc:
        raise RuntimeError(_firestore_http_error(exc, f'query {collection_id}')) from exc
    return [
        _firestore_decode_document(item['document'])
        for item in payload if item.get('document')
    ]

def firestore_batch_set_documents(records):
    """يكتب عدة وثائق في طلب واحد؛ يعيد فوراً للقائمة الفارغة."""
    if not records:
        return
    project_id, token = _firestore_credentials()
    writes = []
    for document_path, data in records:
        fields = {str(key): _firestore_value(value) for key, value in data.items()}
        writes.append({
            'update': {
                'name': (
                    f'projects/{project_id}/databases/{firestore_database_name()}'
                    f'/documents/{document_path.strip("/")}'
                ),
                'fields': fields,
            },
            'updateMask': {'fieldPaths': list(fields)},
        })
    url = (
        f'https://firestore.googleapis.com/v1/projects/{project_id}'
        f'/databases/{firestore_database_path()}/documents:batchWrite'
    )
    req = urllib.request.Request(
        url,
        data=json.dumps({'writes': writes}, ensure_ascii=False).encode(),
        method='POST',
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json; charset=utf-8',
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as response:
            response.read()
    except urllib.error.HTTPError as exc:
        raise RuntimeError(_firestore_http_error(exc, 'batchWrite')) from exc

def durable_write(document_path: str, data: dict, *, merge: bool = True) -> bool:
    """اكتب إلى المخزن الدائم أو ارفع خطأ في النشر ذي التخزين الإلزامي."""
    if firestore_durable_available():
        firestore_set_document(document_path, data, merge=merge)
        return True
    if durable_storage_required():
        raise RuntimeError('التخزين الدائم مطلوب لكن بيانات اعتماد Firestore غير مكتملة')
    return False

# ─── Firestore REST upsert ───────────────────────────────────────────────────
def firestore_upsert_subscription(uid: str, status: str, expires_at=None) -> bool:
    """
    يحدّث (أو ينشئ) وثيقة Firestore في المسار subscriptions/{uid}.

    المصادقة (بالأولوية):
    1. FIREBASE_SERVICE_ACCOUNT_JSON (متغير بيئة يحتوي على JSON مفتاح الخدمة)
       → يُنشئ JWT موقَّع بـ RS256 ويستخدم Bearer token — آمن تماماً.
    2. إذا لم يُهيَّأ → يتخطى التحديث ويُعيد False مع تسجيل تحذير.

    يُعيد True عند النجاح، False عند الفشل (مع طباعة الخطأ).
    """
    try:
        payload = {
            'uid': uid,
            'status': status,
            'updated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        }
        if expires_at is not None:
            payload['expires_at'] = expires_at
        durable_write(f'subscriptions/{uid}', payload)
        return True
    except Exception as exc:
        print(f'[Firestore] خطأ: {exc}')
        return False

def firestore_delete_subscription(uid: str) -> None:
    """احذف كل وثائق Firestore المرتبطة بالحساب أو ارفض نجاح العملية."""
    if not firestore_durable_available():
        raise RuntimeError('بيانات اعتماد Firestore غير مكتملة')

    reverse_identity = firestore_get_document(f'revenuecat_users/{uid}')
    rc_app_user_id = (reverse_identity or {}).get('rc_app_user_id')

    # Firestore لا يحذف المجموعات الفرعية عند حذف الوثيقة الأب؛ لذلك نحذفها
    # صراحةً قبل وثائق المستوى الأعلى.
    for subcollection in ('question_seen', 'game_events', 'ios_diagnostics'):
        for document in firestore_list_documents(f'users/{uid}/{subcollection}'):
            firestore_delete_document(
                f'users/{uid}/{subcollection}/{document["_document_id"]}')

    for report in firestore_query_documents('question_reports', 'uid', uid):
        firestore_delete_document(f'question_reports/{report["_document_id"]}')

    # أحداث RevenueCat تحتوي نسخة من payload ومعرّفات المعاملة. نحذف ما
    # يشير إلى uid مباشرةً، وما يتصل بمعرّف RevenueCat في rc_ids (مهم لأحداث
    # TRANSFER التي قد تُسند الوثيقة النهائية إلى الحساب الوجهة فقط).
    revenuecat_events = {
        document['_document_id']: document
        for document in firestore_query_documents('revenuecat_events', 'uid', uid)
    }
    if rc_app_user_id:
        for document in firestore_query_documents(
                'revenuecat_events', 'rc_ids', rc_app_user_id,
                op='ARRAY_CONTAINS'):
            revenuecat_events[document['_document_id']] = document
        for document in firestore_list_documents(
                f'revenuecat_pending/{rc_app_user_id}/events'):
            firestore_delete_document(
                f'revenuecat_pending/{rc_app_user_id}/events/'
                f'{document["_document_id"]}')
    for event_id in revenuecat_events:
        firestore_delete_document(f'revenuecat_events/{event_id}')

    for document_path in (
        f'users/{uid}',
        f'subscriptions/{uid}',
        f'free_rounds/{uid}',
        f'revenuecat_users/{uid}',
        f'ai_rate_limits/{uid}',
    ):
        firestore_delete_document(document_path)
    if rc_app_user_id:
        firestore_delete_document(f'revenuecat_pending/{rc_app_user_id}')
        firestore_delete_document(f'revenuecat_identities/{rc_app_user_id}')

# ─── RevenueCat: صندوق وارد دائم ومعالجة قابلة للإعادة ─────────────────────
RC_ACTIVE_EVENTS = {
    'INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'UNCANCELLATION',
    'BILLING_ISSUE_RESOLVED', 'CANCELLATION', 'BILLING_ISSUE',
    'SUBSCRIPTION_EXTENDED', 'TEMPORARY_ENTITLEMENT_GRANT',
    'REFUND_REVERSED', 'NON_RENEWING_PURCHASE',
}
RC_INACTIVE_EVENTS = {'EXPIRATION'}
RC_IGNORED_EVENTS = {
    'SUBSCRIBER_ALIAS', 'TEST', 'RC_BILLING_ADDRESS_CHANGE', 'PAUSE',
}

def _revenuecat_expiration(edata):
    try:
        expiration_ms = int(edata.get('expiration_at_ms') or 0)
        if expiration_ms > 0:
            return time.strftime(
                '%Y-%m-%d %H:%M:%S', time.gmtime(expiration_ms / 1000))
    except (TypeError, ValueError, OverflowError):
        pass
    return None

def _revenuecat_ids(edata):
    aliases = edata.get('aliases') or []
    if not isinstance(aliases, list):
        aliases = []
    candidates = [edata.get('app_user_id'), *aliases]
    result = []
    for value in candidates:
        if not isinstance(value, str):
            continue
        normalized = value.strip().lower()
        if normalized and normalized not in result:
            result.append(normalized)
    return result

def resolve_revenuecat_uid(rc_ids):
    """حل هوية RevenueCat من Firestore أولاً ثم كاش SQLite للترقية."""
    if firestore_durable_available():
        for rc_app_user_id in rc_ids:
            document = firestore_get_document(
                f'revenuecat_identities/{rc_app_user_id}')
            uid = (document or {}).get('uid')
            if uid:
                conn = db_connect()
                try:
                    conn.execute('''
                        INSERT INTO revenuecat_identities (uid, rc_app_user_id)
                        VALUES (?,?)
                        ON CONFLICT(uid) DO UPDATE SET
                            rc_app_user_id=excluded.rc_app_user_id,
                            updated_at=CURRENT_TIMESTAMP
                    ''', (uid, rc_app_user_id))
                    conn.commit()
                except sqlite3.IntegrityError:
                    conn.rollback()
                finally:
                    conn.close()
                return uid
    conn = db_connect()
    try:
        if not rc_ids:
            return None
        placeholders = ','.join('?' * len(rc_ids))
        row = conn.execute(
            f'SELECT uid FROM revenuecat_identities '
            f'WHERE rc_app_user_id IN ({placeholders}) LIMIT 1',
            rc_ids,
        ).fetchone()
        return row[0] if row else None
    finally:
        conn.close()

def _cache_subscription(uid: str, status: str, expires_at=None):
    conn = db_connect()
    try:
        conn.execute('''INSERT INTO subscriptions (uid, status, expires_at)
            VALUES (?,?,?)
            ON CONFLICT(uid) DO UPDATE SET
            status=excluded.status,
            expires_at=COALESCE(excluded.expires_at, subscriptions.expires_at),
            updated_at=CURRENT_TIMESTAMP''', (uid, status, expires_at))
        conn.commit()
    finally:
        conn.close()

def _local_revenuecat_event_processed(event_id: str) -> bool:
    conn = db_connect()
    try:
        return bool(conn.execute(
            'SELECT 1 FROM revenuecat_events WHERE event_id=?',
            (event_id,)).fetchone())
    finally:
        conn.close()

def _cache_revenuecat_event(event_id: str, event_type: str, uid: str,
                            event: dict, rc_ids, status='processed'):
    conn = db_connect()
    try:
        conn.execute('''
            INSERT OR REPLACE INTO revenuecat_events
            (event_id, event_type, uid, status, payload, rc_ids, processed_at)
            VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)
        ''', (
            event_id, event_type, uid or '', status,
            json.dumps(event, ensure_ascii=False, separators=(',', ':')),
            json.dumps(rc_ids, ensure_ascii=False),
        ))
        conn.commit()
    finally:
        conn.close()

def _persist_revenuecat_event(event: dict, status: str, uid='', note=''):
    edata = event.get('event') or {}
    event_id = str(edata.get('id') or '').strip()
    record = {
        'event_id': event_id,
        'event_type': str(edata.get('type') or '').strip(),
        'status': status,
        'uid': uid or '',
        'rc_ids': _revenuecat_ids(edata),
        'payload_json': json.dumps(event, ensure_ascii=False, separators=(',', ':')),
        'note': note,
        'updated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }
    durable_write(f'revenuecat_events/{event_id}', record)

def _persist_pending_revenuecat_event(event: dict, rc_ids):
    _persist_revenuecat_event(
        event, 'pending_identity', note='waiting_for_verified_identity')
    edata = event.get('event') or {}
    event_id = str(edata.get('id') or '').strip()
    payload_json = json.dumps(event, ensure_ascii=False, separators=(',', ':'))
    if firestore_durable_available():
        firestore_batch_set_documents([
            (f'revenuecat_pending/{rc_app_user_id}/events/{event_id}', {
                'event_id': event_id,
                'rc_app_user_id': rc_app_user_id,
                'payload_json': payload_json,
                'created_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            })
            for rc_app_user_id in rc_ids
            if rc_app_user_id and '/' not in rc_app_user_id
        ])

def process_revenuecat_event(event: dict):
    """معالجة idempotent؛ تعيد (HTTP status, response)."""
    edata = event.get('event') or {}
    event_type = str(edata.get('type') or '').strip()
    event_id = str(edata.get('id') or '').strip()
    if not event_type:
        return 400, {'error': 'event.type مطلوب'}
    if not re.fullmatch(r'[A-Za-z0-9._:-]{1,160}', event_id):
        return 400, {'error': 'event.id غير صالح لمنع تكرار المعاملة'}

    if firestore_durable_available():
        existing = firestore_get_document(f'revenuecat_events/{event_id}')
        if existing and existing.get('status') == 'processed':
            return 200, {
                'received': True, 'duplicate': True,
                'uid': existing.get('uid') or '', 'event_id': event_id,
            }
        _persist_revenuecat_event(event, 'received')
    elif durable_storage_required():
        raise RuntimeError('صندوق وارد RevenueCat الدائم غير مهيأ')
    elif _local_revenuecat_event_processed(event_id):
        return 200, {'received': True, 'duplicate': True, 'event_id': event_id}

    # أحداث معلوماتية: نحفظ قرار التجاهل كي لا تتكرر معالجتها.
    if event_type in RC_IGNORED_EVENTS or event_type not in (
            RC_ACTIVE_EVENTS | RC_INACTIVE_EVENTS | {'TRANSFER'}):
        note = 'ignored' if event_type in RC_IGNORED_EVENTS else 'unknown_ignored'
        if firestore_durable_available():
            _persist_revenuecat_event(event, 'processed', note=note)
        _cache_revenuecat_event(event_id, event_type, '', event, [], 'processed')
        return 200, {'received': True, 'note': f'event {event_type} {note}'}

    if event_type == 'TRANSFER':
        transferred_from = edata.get('transferred_from') or []
        transferred_to = edata.get('transferred_to') or []
        if not isinstance(transferred_from, list) or not isinstance(transferred_to, list):
            return 400, {'error': 'بيانات TRANSFER غير صالحة'}
        source_ids = [str(value).strip().lower() for value in transferred_from if value]
        destination_ids = [str(value).strip().lower() for value in transferred_to if value]
        source_uid = resolve_revenuecat_uid(source_ids)
        destination_uid = resolve_revenuecat_uid(destination_ids)
        if not destination_uid:
            pending_ids = list(dict.fromkeys([*source_ids, *destination_ids]))
            _persist_pending_revenuecat_event(event, pending_ids)
            return 202, {
                'received': True, 'persisted': firestore_durable_available(),
                'note': 'TRANSFER محفوظ وينتظر ربط الهوية الوجهة',
            }
        if source_uid and source_uid != destination_uid:
            if firestore_durable_available():
                firestore_set_document(f'subscriptions/{source_uid}', {
                    'uid': source_uid, 'status': 'inactive',
                    'updated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                })
            _cache_subscription(source_uid, 'inactive')
        if firestore_durable_available():
            firestore_set_document(f'subscriptions/{destination_uid}', {
                'uid': destination_uid, 'status': 'active',
                'updated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            })
            _persist_revenuecat_event(event, 'processed', destination_uid, 'transfer_applied')
        _cache_subscription(destination_uid, 'active')
        _cache_revenuecat_event(
            event_id, event_type, destination_uid, event,
            [*source_ids, *destination_ids], 'processed')
        return 200, {
            'received': True, 'uid': destination_uid, 'status': 'active',
            'transferredFromUid': source_uid,
        }

    rc_ids = _revenuecat_ids(edata)
    if not rc_ids:
        return 400, {'error': 'app_user_id مطلوب'}
    resolved_uid = resolve_revenuecat_uid(rc_ids)
    if not resolved_uid:
        _persist_pending_revenuecat_event(event, rc_ids)
        return 202, {
            'received': True, 'persisted': firestore_durable_available(),
            'note': 'الحدث محفوظ وينتظر ربط app_user_id بحساب Firebase',
        }

    new_status = 'active' if event_type in RC_ACTIVE_EVENTS else 'inactive'
    expiration_at = _revenuecat_expiration(edata)
    if firestore_durable_available():
        subscription_record = {
            'uid': resolved_uid,
            'status': new_status,
            'updated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        }
        if expiration_at is not None:
            subscription_record['expires_at'] = expiration_at
        firestore_set_document(f'subscriptions/{resolved_uid}', subscription_record)
        _persist_revenuecat_event(event, 'processed', resolved_uid, 'entitlement_applied')
    _cache_subscription(resolved_uid, new_status, expiration_at)
    _cache_revenuecat_event(
        event_id, event_type, resolved_uid, event, rc_ids, 'processed')
    return 200, {'received': True, 'uid': resolved_uid, 'status': new_status}

def replay_pending_revenuecat_events(rc_app_user_id: str) -> int:
    if not firestore_durable_available():
        return 0
    pending = firestore_list_documents(
        f'revenuecat_pending/{rc_app_user_id}/events')
    replayed = 0
    for document in pending:
        try:
            event = json.loads(document.get('payload_json') or '{}')
            status, _ = process_revenuecat_event(event)
            if status == 200:
                firestore_delete_document(
                    f'revenuecat_pending/{rc_app_user_id}/events/'
                    f'{document["_document_id"]}')
                replayed += 1
        except Exception as exc:
            print(f'[RevenueCat] replay failed event={document.get("event_id")}: {exc}')
    return replayed

# ─── قراءة index.html ────────────────────────────────────────────────────────
def read_html():
    with open(HTML_FILE, 'rb') as f:
        return f.read()

# ─── Firebase config ─────────────────────────────────────────────────────────
def firebase_config_js():
    cfg = {
        'apiKey':            os.environ.get('GOOGLE_API_KEY', ''),
        'authDomain':        os.environ.get('FIREBASE_AUTH_DOMAIN', ''),
        'projectId':         os.environ.get('FIREBASE_PROJECT_ID', ''),
        'storageBucket':     os.environ.get('FIREBASE_STORAGE_BUCKET', ''),
        'appId':             os.environ.get('FIREBASE_APP_ID', ''),
        'messagingSenderId': os.environ.get('FIREBASE_MESSAGING_SENDER_ID', ''),
    }
    configured = all(cfg.values())
    return (
        f'window.FIREBASE_CONFIG = {json.dumps(cfg)};\n'
        f'window.FIREBASE_CONFIGURED = {"true" if configured else "false"};\n'
    ).encode()

# ─── صفحات قانونية عامة (لمتطلبات App Store Connect) ────────────────────────
PRIVACY_BODY = '''
<h1>سياسة الخصوصية</h1>
<p><b>آخر تحديث: 20 أغسطس 2026</b></p>
<p>تطبيق <b>فطنة</b> يحترم خصوصيتك ويلتزم بحمايتها. نجمع الحد الأدنى اللازم لتشغيل الحساب ومزامنة التقدم وتفعيل الاشتراك وحماية الخدمة وتحسين ثباتها.</p>
<p><b>البيانات التي نجمعها:</b><br>
• الاسم والبريد أو رقم الهاتف ومعرّف الحساب بحسب وسيلة الدخول<br>
• إحصاءات اللعب والأسئلة المشاهدة ومؤشرات الجولات وبلاغات الأسئلة<br>
• حالة الاشتراك ومعرّفات معاملة مجهّلة عبر Apple وRevenueCat<br>
• رمز الإشعارات بعد موافقتك، وتقارير الأعطال والتوقفات والأداء<br>
• رمز سلامة قصير العمر عبر Firebase App Check وApple App Attest</p>
<p><b>ما لا نجمعه:</b><br>
لا نبيع بياناتك، ولا نعرض إعلانات، ولا نتتبعك عبر التطبيقات. لا نطلب جهات الاتصال أو الصور أو الموقع الدقيق أو الصحة أو الميكروفون أو الكاميرا.</p>
<p><b>الخدمات:</b><br>
نستخدم Firebase Authentication وMessaging وCrashlytics وApp Check، وApple MetricKit وApp Attest، وRevenueCat، بالقدر اللازم للأغراض الموضحة أعلاه.</p>
<p><b>الاشتراكات:</b><br>
تُعالَج مدفوعات iOS عبر Apple App Store وتخضع لسياسة خصوصية Apple. لإلغاء الاشتراك: الإعدادات ← اسمك ← الاشتراكات.</p>
<p><b>الحذف:</b><br>
يمكنك حذف الحساب وبياناته من داخل شاشة الحساب. حذف حساب فطنة لا يلغي اشتراك App Store تلقائياً.</p>
<p><b>التواصل:</b><br>
لأي استفسار: fatinahgame@gmail.com</p>
'''

TERMS_BODY = '''
<h1>شروط الاستخدام</h1>
<p><b>آخر تحديث: يوليو 2025</b></p>
<p>باستخدامك تطبيق <b>فطنة</b> فأنت توافق على هذه الشروط.</p>
<p><b>الاشتراك:</b><br>
• الاشتراك الشهري: $3.99 شهرياً<br>
• الاشتراك السنوي: $29.99 سنوياً<br>
• يتجدد الاشتراك تلقائياً ما لم يُلغَ قبل 24 ساعة من انتهاء الفترة الحالية<br>
• يمكن إلغاؤه في أي وقت من إعدادات Apple ID</p>
<p><b>الاستخدام المقبول:</b><br>
التطبيق للاستخدام الشخصي والترفيهي. يُحظر نسخ المحتوى أو إعادة توزيعه.</p>
<p><b>الملكية الفكرية:</b><br>
جميع محتويات التطبيق محمية بحقوق النشر لصالح مطوّر فطنة.</p>
<p><b>إخلاء المسؤولية:</b><br>
التطبيق مقدَّم "كما هو" بدون ضمانات. المطوّر غير مسؤول عن أي أضرار ناجمة عن الاستخدام.</p>
<p><b>التواصل:</b><br>
boturki13@gmail.com</p>
'''

def legal_page_html(kind: str) -> bytes:
    title = 'سياسة الخصوصية' if kind == 'privacy' else 'شروط الاستخدام'
    content = PRIVACY_BODY if kind == 'privacy' else TERMS_BODY
    page = f'''<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} — فطنة</title>
<style>
  body {{ font-family: -apple-system, "Segoe UI", Tahoma, Arial, sans-serif;
         background:#0f1220; color:#e8e6f0; margin:0; padding:24px;
         line-height:1.9; font-size:16px; }}
  main {{ max-width:720px; margin:0 auto; background:#191d33;
          border:1px solid #2a2f4f; border-radius:16px; padding:28px; }}
  h1 {{ color:#f5c542; font-size:24px; margin-top:0; }}
  a {{ color:#f5c542; }}
  footer {{ text-align:center; color:#8a8fa8; font-size:13px; margin-top:20px; }}
</style>
</head>
<body>
<main>{content}</main>
<footer>فطنة © 2026 — <a href="/privacy">سياسة الخصوصية</a> · <a href="/terms">شروط الاستخدام</a></footer>
</body>
</html>'''
    return page.encode()

# ─── HTTP handler ─────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    # حدود حجم الجسم لكل نقطة API (بايت) — يمنع الطلبات الضخمة
    _DEFAULT_MAX_BODY = 64 * 1024          # 64 كيلوبايت للنقاط العامة
    _MAX_BODY = {
        '/api/generate':              8  * 1024,   # موضوع + قائمة seen
        '/api/revenuecat/webhook':    32 * 1024,   # RevenueCat events
        '/api/account/delete':        4  * 1024,
        '/api/account/profile':       4  * 1024,
        '/api/questions/seen':       32  * 1024,
        '/api/ios-diagnostics':     640  * 1024,
    }

    def log_message(self, fmt, *args):
        pass

    def send_asset(self, body: bytes, content_type: str, cache_control: str,
                   *, compress: bool = True, extra_headers=None):
        """أرسل أصلاً مع ضغط اختياري وETag ثابت لإعادة تحقق 304 رخيصة."""
        etag = '"' + hashlib.sha256(body).hexdigest() + '"'
        common_headers = {
            'Cache-Control': cache_control,
            'ETag': etag,
            'X-Content-Type-Options': 'nosniff',
            **(extra_headers or {}),
        }
        if self.headers.get('If-None-Match', '').strip() == etag:
            self.send_response(304)
            for key, value in common_headers.items():
                self.send_header(key, value)
            if compress:
                self.send_header('Vary', 'Accept-Encoding')
            self.end_headers()
            return

        accepts_gzip = 'gzip' in (self.headers.get('Accept-Encoding', '') or '').lower()
        use_gzip = compress and accepts_gzip and len(body) >= 1024
        payload = gzip.compress(body, compresslevel=6) if use_gzip else body
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(payload)))
        for key, value in common_headers.items():
            self.send_header(key, value)
        if compress:
            self.send_header('Vary', 'Accept-Encoding')
        if use_gzip:
            self.send_header('Content-Encoding', 'gzip')
        self.end_headers()
        self.wfile.write(payload)

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type',   'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def app_integrity_allows(self, path: str) -> bool:
        valid, reason = verify_app_check_header(self.headers, path)
        if valid:
            return True
        if app_check_enforcement_enabled():
            self.send_json(401, {
                'error': 'تعذّر التحقق من سلامة نسخة التطبيق',
                'code': 'app_check_failed',
            })
            return False
        # الإطلاق التدريجي: راقب النسبة أولاً ثم فعّل الإنفاذ من البيئة.
        print(f'[App Check] monitor path={path} reason={reason}')
        return True

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin',  '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers',
                         'Content-Type, Authorization, X-Firebase-AppCheck')
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path   = parsed.path
        params = urllib.parse.parse_qs(parsed.query)

        if not self.app_integrity_allows(path):
            return

        # أزيلت أكواد التفعيل الخاصة امتثالاً لسياسة مشتريات Apple. أي عروض
        # ترويجية يجب أن تمر عبر StoreKit Offer Codes فقط.
        if path == '/admin/promo' or path.startswith('/api/promo/'):
            self.send_json(410, {'error': 'تم إيقاف أكواد التفعيل الخاصة؛ استخدم Apple Offer Codes'}); return

        if path == '/api/rc-config':
            # مفتاح RevenueCat publishable (iOS) — يُقدَّم من البيئة بدلاً من تضمينه في HTML
            self.send_json(200, {'apiKey': os.environ.get('REVENUECAT_IOS_API_KEY', '')})

        elif path == '/firebase-config.js':
            body = firebase_config_js()
            self.send_response(200)
            self.send_header('Content-Type',   'application/javascript; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(body)

        elif path == '/api/auth/check-anonymous':
            # نقطة تشخيص: تتحقق هل مزوّد Anonymous مفعّل في Firebase Console.
            # محمية بـ X-Admin-Secret لأنها تُنشئ مستخدماً مؤقتاً ثم تحذفه.
            admin_secret = os.environ.get('ADMIN_SECRET', '')
            auth_header  = self.headers.get('X-Admin-Secret', '')
            if not admin_secret or auth_header != admin_secret:
                self.send_json(403, {'error': 'غير مصرح'}); return
            api_key = os.environ.get('GOOGLE_API_KEY', '')
            if not api_key or not firebase_is_configured():
                self.send_json(200, {'enabled': None, 'reason': 'not_configured'}); return
            try:
                # نحاول تسجيل دخول مجهول عبر REST
                payload = json.dumps({'returnSecureToken': True}).encode()
                req = urllib.request.Request(
                    f'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key={api_key}',
                    data=payload, method='POST',
                    headers={'Content-Type': 'application/json'})
                with urllib.request.urlopen(req, timeout=10) as resp:
                    data = json.loads(resp.read())
                id_token = data.get('idToken')
                # نحذف المستخدم المؤقت فوراً تجنّباً للتلوث
                if id_token:
                    del_payload = json.dumps({'idToken': id_token}).encode()
                    del_req = urllib.request.Request(
                        f'https://identitytoolkit.googleapis.com/v1/accounts:delete?key={api_key}',
                        data=del_payload, method='POST',
                        headers={'Content-Type': 'application/json'})
                    try:
                        urllib.request.urlopen(del_req, timeout=5)
                    except Exception:
                        pass  # الحذف اختياري، لا يُوقف الاستجابة
                self.send_json(200, {'enabled': True})
            except urllib.error.HTTPError as e:
                body = e.read().decode('utf-8', errors='replace')
                if 'ADMIN_ONLY_OPERATION' in body:
                    self.send_json(200, {'enabled': False, 'reason': 'ADMIN_ONLY_OPERATION'})
                else:
                    self.send_json(200, {'enabled': None, 'reason': body[:200]})
            except Exception as ex:
                self.send_json(200, {'enabled': None, 'reason': str(ex)[:200]})

        elif path == '/api/subscription/status':
            uid = (params.get('uid') or [''])[0]
            if not uid:
                self.send_json(400, {'error': 'uid مطلوب'}); return
            if not uid_matches_token(uid, bearer_token(self.headers)):
                self.send_json(401, {'error': 'رمز الدخول غير صالح — سجّل دخولك مرة أخرى'}); return
            source = 'cache'
            if firestore_durable_available():
                try:
                    document = firestore_get_document(f'subscriptions/{uid}')
                    if document:
                        conn = db_connect()
                        try:
                            conn.execute('''INSERT INTO subscriptions (uid, status, expires_at)
                                VALUES (?,?,?)
                                ON CONFLICT(uid) DO UPDATE SET
                                status=excluded.status,
                                expires_at=excluded.expires_at,
                                updated_at=CURRENT_TIMESTAMP''', (
                                uid, document.get('status') or 'inactive',
                                document.get('expires_at')))
                            conn.commit()
                        finally:
                            conn.close()
                    source = 'firestore'
                except Exception as exc:
                    print(f'[Subscription] Firestore read failed uid={uid}: {exc}')
                    if durable_storage_required():
                        self.send_json(503, {'error': 'تعذّر التحقق من الاشتراك الآن'}); return
            conn = db_connect()
            try:
                row = conn.execute(
                    'SELECT status, expires_at FROM subscriptions WHERE uid=?',
                    (uid,)).fetchone()
                active = bool(row and row[0] == 'active')
                if active and row[1] and not conn.execute(
                        "SELECT 1 WHERE ? > datetime('now')", (row[1],)).fetchone():
                    conn.execute(
                        "UPDATE subscriptions SET status='inactive', updated_at=CURRENT_TIMESTAMP "
                        "WHERE uid=? AND status='active'", (uid,))
                    conn.commit()
                    active = False
            finally:
                conn.close()
            self.send_json(200, {'active': active, 'source': source})

        elif path == '/api/free-round/status':
            uid = (params.get('uid') or [''])[0].strip()
            if not uid:
                self.send_json(400, {'error': 'uid مطلوب'}); return
            if not uid_matches_token(uid, bearer_token(self.headers)):
                self.send_json(401, {'error': 'رمز الدخول غير صالح — سجّل دخولك مرة أخرى'}); return
            if firestore_durable_available():
                try:
                    document = firestore_get_document(f'free_rounds/{uid}')
                    if document and document.get('completed') is True:
                        conn = db_connect()
                        try:
                            conn.execute('INSERT OR IGNORE INTO free_rounds (uid) VALUES (?)', (uid,))
                            conn.commit()
                        finally:
                            conn.close()
                except Exception as exc:
                    print(f'[Free Round] Firestore read failed uid={uid}: {exc}')
                    if durable_storage_required():
                        self.send_json(503, {'error': 'تعذّر التحقق من الجولة المجانية الآن'}); return
            conn = db_connect()
            try:
                completed = bool(conn.execute(
                    'SELECT 1 FROM free_rounds WHERE uid=?', (uid,)
                ).fetchone())
            finally:
                conn.close()
            self.send_json(200, {'eligible': not completed, 'completed': completed})

        elif path == '/api/questions/seen':
            uid = (params.get('uid') or [''])[0].strip()
            if not uid:
                self.send_json(400, {'error': 'uid مطلوب'}); return
            if not uid_matches_token(uid, bearer_token(self.headers)):
                self.send_json(401, {'error': 'رمز الدخول غير صالح — سجّل دخولك مرة أخرى'}); return
            if firestore_durable_available():
                try:
                    documents = firestore_list_documents(f'users/{uid}/question_seen')
                    if documents:
                        conn = db_connect()
                        try:
                            conn.executemany('''
                                INSERT INTO question_seen (uid, question_id, category, seen_at)
                                VALUES (?, ?, ?, ?)
                                ON CONFLICT(uid, question_id) DO UPDATE SET
                                    category=excluded.category,
                                    seen_at=excluded.seen_at
                            ''', [(
                                uid, document.get('question_id') or document['_document_id'],
                                document.get('category') or 'غير مصنف',
                                document.get('seen_at') or time.strftime('%Y-%m-%d %H:%M:%S'),
                            ) for document in documents])
                            conn.commit()
                        finally:
                            conn.close()
                except Exception as exc:
                    print(f'[Question Seen] Firestore read failed uid={uid}: {exc}')
                    if durable_storage_required():
                        self.send_json(503, {'error': 'تعذّرت مزامنة سجل الأسئلة الآن'}); return
            conn = db_connect()
            try:
                rows = conn.execute(
                    'SELECT question_id, category, seen_at FROM question_seen '
                    'WHERE uid=? ORDER BY seen_at DESC LIMIT 10000',
                    (uid,)
                ).fetchall()
            finally:
                conn.close()
            self.send_json(200, {
                'items': [
                    {'id': row[0], 'category': row[1], 'seenAt': row[2]}
                    for row in rows
                ],
                'bankVersion': 3,
            })

        elif path in ('/', '/index.html'):
            body = read_html()
            # طبقة دفاع إضافية ضد XSS: تمنع تحميل سكربتات خارجية وتقيّد
            # الوجهات التي يمكن لأي كود مُدرَج أن يرسل لها بيانات.
            content_security_policy = (
                "default-src 'self'; "
                "script-src 'self' 'unsafe-inline' https://www.gstatic.com; "
                "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
                "font-src 'self' https://fonts.gstatic.com; "
                "img-src 'self' data:; "
                "connect-src 'self' https://ata20.com https://api.revenuecat.com "
                "https://identitytoolkit.googleapis.com https://securetoken.googleapis.com "
                "https://www.googleapis.com https://firestore.googleapis.com; "
                "object-src 'none'; base-uri 'self'; frame-ancestors 'self'")
            self.send_asset(
                body, 'text/html; charset=utf-8', 'no-cache',
                extra_headers={'Content-Security-Policy': content_security_policy})

        elif path in ('/app.js', '/app.css', '/question-bank.js', '/approved-question-bank.js',
                      '/privacy-policy.html', '/terms-of-service.html'):
            fname = path.lstrip('/')
            ctype = ('application/javascript; charset=utf-8' if fname.endswith('.js')
                     else 'text/css; charset=utf-8' if fname.endswith('.css')
                     else 'text/html; charset=utf-8')
            full_path = os.path.realpath(os.path.join(WWW_DIR, fname))
            if not full_path.startswith(os.path.realpath(WWW_DIR) + os.sep):
                self.send_response(404); self.end_headers(); return
            try:
                with open(full_path, 'rb') as f:
                    body = f.read()
                cache_control = ('no-cache' if fname.endswith(('.js', '.html'))
                                 else 'public, max-age=3600')
                self.send_asset(body, ctype, cache_control)
            except FileNotFoundError:
                self.send_response(404); self.end_headers()

        elif path in ('/favicon.ico', '/apple-touch-icon.png', '/og-image.png'):
            fname = path.lstrip('/')
            ctype = 'image/x-icon' if fname.endswith('.ico') else 'image/png'
            try:
                with open(os.path.join(os.path.dirname(__file__), fname), 'rb') as f:
                    body = f.read()
                self.send_asset(body, ctype, 'public, max-age=86400', compress=False)
            except FileNotFoundError:
                self.send_response(404); self.end_headers()

        elif path.startswith('/legal/img/'):
            fname = os.path.basename(path[len('/legal/img/'):])
            img_dir = os.path.realpath(os.path.join(os.path.dirname(__file__), 'legal', 'img'))
            full_path = os.path.realpath(os.path.join(img_dir, fname))
            if not full_path.startswith(img_dir + os.sep):
                self.send_response(404); self.end_headers()
                return
            ctype = ('image/x-icon' if fname.endswith('.ico')
                     else 'image/svg+xml' if fname.endswith('.svg')
                     else 'image/png')
            try:
                with open(full_path, 'rb') as f:
                    body = f.read()
                self.send_asset(
                    body, ctype, 'public, max-age=86400',
                    compress=ctype.startswith('image/svg+xml'))
            except FileNotFoundError:
                self.send_response(404); self.end_headers()

        elif path in ('/privacy', '/terms', '/legal', '/legal/', '/legal/index.html',
                      '/legal/privacy.html', '/legal/terms.html', '/legal/styles.css', '/robots.txt'):
            fname = {
                '/privacy': 'privacy.html', '/terms': 'terms.html',
                '/legal': 'index.html', '/legal/': 'index.html', '/legal/index.html': 'index.html',
                '/legal/privacy.html': 'privacy.html', '/legal/terms.html': 'terms.html',
                '/legal/styles.css': 'styles.css', '/robots.txt': 'robots.txt',
            }[path]
            ctype = ('text/css; charset=utf-8' if fname.endswith('.css')
                     else 'text/plain; charset=utf-8' if fname.endswith('.txt')
                     else 'text/html; charset=utf-8')
            try:
                with open(os.path.join(os.path.dirname(__file__), 'legal', fname), 'rb') as f:
                    body = f.read()
                self.send_asset(body, ctype, 'no-cache')
            except FileNotFoundError:
                self.send_response(404); self.end_headers()

        elif path == '/download/index.html':
            with open(HTML_FILE, 'rb') as f:
                body = f.read()
            self.send_response(200)
            self.send_header('Content-Type',        'application/octet-stream')
            self.send_header('Content-Disposition', 'attachment; filename="index.html"')
            self.send_header('Content-Length',      str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        # ─── حالة الخادم عند بدء التشغيل (admin فقط) ────────────────────────
        elif path == '/api/admin/db-status':
            admin_secret = os.environ.get('ADMIN_SECRET', '')
            auth_header  = self.headers.get('X-Admin-Secret', '')
            if not admin_secret or auth_header != admin_secret:
                self.send_json(403, {'error': 'غير مصرح'}); return
            self.send_json(200, _startup_status)

        elif path == '/api/admin/metrics':
            admin_secret = os.environ.get('ADMIN_SECRET', '')
            auth_header = self.headers.get('X-Admin-Secret', '')
            if not admin_secret or auth_header != admin_secret:
                self.send_json(403, {'error': 'غير مصرح'}); return
            try:
                days = max(1, min(90, int((params.get('days') or ['7'])[0])))
            except ValueError:
                days = 7
            conn = db_connect()
            try:
                event_rows = conn.execute('''
                    SELECT event_name, COUNT(*)
                    FROM game_events
                    WHERE created_at >= datetime('now', ?)
                    GROUP BY event_name ORDER BY COUNT(*) DESC
                ''', (f'-{days} days',)).fetchall()
                report_rows = conn.execute('''
                    SELECT email_status, COUNT(*)
                    FROM question_reports
                    WHERE created_at >= datetime('now', ?)
                    GROUP BY email_status
                ''', (f'-{days} days',)).fetchall()
            finally:
                conn.close()
            self.send_json(200, {
                'days': days,
                'events': {name: count for name, count in event_rows},
                'questionReports': {status: count for status, count in report_rows},
            })

        else:
            self.send_response(404); self.end_headers()

    # حدود حجم body لكل نقطة POST — تُعيد 413 مبكراً قبل قراءة البيانات
    _MAX_BODY: dict = {
        '/api/generate':                1_024,   # مسار متوقف للإصدارات القديمة
        '/api/account/delete':          4_096,   # 4 KB   (uid + idToken)
        '/api/revenuecat/webhook':     65_536,   # 64 KB  (حدث RevenueCat)
        '/api/revenuecat/identity':     2_048,   # uid + UUID + token
        '/api/account/profile':         2_048,   # 2 KB   (name + email + provider)
        '/api/questions/seen':          32_768,  # حتى 100 معرّف في دفعة مزامنة
        '/api/free-round/complete':      2_048,
        '/api/questions/report':         8_192,
        '/api/metrics/event':            4_096,
        '/api/ios-diagnostics':        655_360,
    }
    _DEFAULT_MAX_BODY = 16_384  # 16 KB للمسارات غير المدرجة

    def do_POST(self):
        path   = self.path.split('?')[0]

        if path.startswith('/api/promo/'):
            self.send_json(410, {'error': 'تم إيقاف أكواد التفعيل الخاصة؛ استخدم Apple Offer Codes'}); return

        # BaseHTTPRequestHandler لا يفك ترميز chunked. كما أن طولاً سالباً
        # يجعل read(-1) ينتظر إغلاق العميل وقد يحتجز خيط الخادم بلا حد.
        transfer_encoding = (self.headers.get('Transfer-Encoding', '') or '').strip().lower()
        raw_length = (self.headers.get('Content-Length', '') or '').strip()
        if transfer_encoding and transfer_encoding != 'identity':
            self.send_json(400, {'error': 'ترميز جسم الطلب غير مدعوم'}); return
        if raw_length and not raw_length.isdigit():
            self.send_json(400, {'error': 'Content-Length غير صالح'}); return
        length = int(raw_length or 0)

        max_allowed = self._MAX_BODY.get(path, self._DEFAULT_MAX_BODY)
        if length > max_allowed:
            self.send_json(413, {'error': f'حجم الطلب كبير جداً (الحد: {max_allowed} بايت)'}); return

        body   = self.rfile.read(length)

        if not self.app_integrity_allows(path):
            return

        # ─── مسار التوليد القديم (متوقف) ────────────────────────────────────
        if path == '/api/generate':
            self.send_json(410, {
                'error': 'تم إيقاف التوليد الآلي. تستخدم فطنة بنك أسئلة مراجعاً مسبقاً.'
            }); return

        elif path == '/api/free-round/complete':
            try: data = json.loads(body)
            except Exception: self.send_json(400, {'error': 'JSON غير صالح'}); return
            uid = str(data.get('uid') or '').strip()
            id_token = str(data.get('idToken') or bearer_token(self.headers) or '').strip()
            if not uid:
                self.send_json(400, {'error': 'uid مطلوب'}); return
            if not uid_matches_token(uid, id_token):
                self.send_json(401, {'error': 'رمز الدخول غير صالح — سجّل دخولك مرة أخرى'}); return
            if rate_limited(f'free-round:{uid}', 10, 600):
                self.send_json(429, {'error': 'طلبات كثيرة جداً — حاول بعد قليل'}); return
            try:
                durable_write(f'free_rounds/{uid}', {
                    'uid': uid,
                    'completed': True,
                    'completed_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                })
            except Exception as exc:
                print(f'[Free Round] durable write failed uid={uid}: {exc}')
                self.send_json(503, {'error': 'تعذّر حفظ الجولة بأمان — ستتم إعادة المحاولة'}); return
            conn = db_connect()
            try:
                conn.execute('INSERT OR IGNORE INTO free_rounds (uid) VALUES (?)', (uid,))
                conn.commit()
            finally:
                conn.close()
            self.send_json(200, {'ok': True, 'completed': True})

        elif path == '/api/questions/report':
            try: data = json.loads(body)
            except Exception: self.send_json(400, {'error': 'JSON غير صالح'}); return
            uid = str(data.get('uid') or '').strip()
            id_token = str(data.get('idToken') or bearer_token(self.headers) or '').strip()
            question_id = str(data.get('questionId') or '').strip()
            category = str(data.get('category') or '').strip()
            question_text = str(data.get('question') or '').strip()
            answer_text = str(data.get('answer') or '').strip()
            reason = str(data.get('reason') or '').strip()
            details = str(data.get('details') or '').strip()
            app_version = str(data.get('appVersion') or '').strip()
            if not uid or not uid_matches_token(uid, id_token):
                self.send_json(401, {'error': 'رمز الدخول غير صالح — سجّل دخولك مرة أخرى'}); return
            if rate_limited(f'question-report:{uid}', 6, 3600):
                self.send_json(429, {'error': 'وصلنا عدد كافٍ من البلاغات الآن — حاول لاحقاً'}); return
            if (not re.fullmatch(r'[A-Za-z0-9._-]{1,128}', question_id)
                    or not category or len(category) > 80
                    or any(ord(char) < 32 for char in category)
                    or not question_text or len(question_text) > 600
                    or len(answer_text) > 400
                    or reason not in REPORT_REASONS
                    or len(details) > 500
                    or len(app_version) > 40):
                self.send_json(400, {'error': 'بيانات البلاغ غير صالحة'}); return
            report_id = str(uuid.uuid4())
            report_record = {
                'report_id': report_id,
                'uid': uid,
                'question_id': question_id,
                'category': category,
                'question_text': question_text,
                'answer_text': answer_text,
                'reason': reason,
                'details': details,
                'app_version': app_version,
                'email_status': 'pending',
                'created_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            }
            try:
                durable_write(f'question_reports/{report_id}', report_record, merge=False)
            except Exception as exc:
                print(f'[Question Report] durable write failed report={report_id}: {exc}')
                self.send_json(503, {'error': 'تعذّر حفظ البلاغ بأمان — حاول مرة أخرى'}); return
            conn = db_connect()
            try:
                conn.execute('''
                    INSERT INTO question_reports
                    (report_id, uid, question_id, category, question_text,
                     answer_text, reason, details, app_version)
                    VALUES (?,?,?,?,?,?,?,?,?)
                ''', (report_id, uid, question_id, category, question_text,
                      answer_text, reason, details, app_version))
                conn.commit()
            finally:
                conn.close()
            # الحفظ هو نقطة النجاح؛ فشل البريد لا يعيد الطلب ولا يفقد البلاغ.
            try:
                deliver_pending_question_reports(limit=5)
            except Exception as exc:
                print(f'[Question Reports] immediate delivery error: {exc}')
            conn = db_connect()
            try:
                row = conn.execute(
                    'SELECT email_status FROM question_reports WHERE report_id=?',
                    (report_id,)).fetchone()
            finally:
                conn.close()
            if firestore_durable_available() and row:
                try:
                    firestore_set_document(f'question_reports/{report_id}', {
                        'email_status': row[0],
                    })
                except Exception as exc:
                    # البلاغ نفسه محفوظ بالفعل؛ حالة البريد تحسين يمكن استعادته.
                    print(f'[Question Report] email state sync failed report={report_id}: {exc}')
            self.send_json(201, {
                'ok': True,
                'reportId': report_id,
                'emailStatus': row[0] if row else 'pending',
            })

        elif path == '/api/metrics/event':
            try: data = json.loads(body)
            except Exception: self.send_json(400, {'error': 'JSON غير صالح'}); return
            uid = str(data.get('uid') or '').strip()
            id_token = str(data.get('idToken') or bearer_token(self.headers) or '').strip()
            event_name = str(data.get('event') or '').strip()
            event_id = str(data.get('eventId') or uuid.uuid4()).strip()
            app_version = str(data.get('appVersion') or '').strip()[:40]
            properties = data.get('properties') or {}
            if not uid or not uid_matches_token(uid, id_token):
                self.send_json(401, {'error': 'رمز الدخول غير صالح — سجّل دخولك مرة أخرى'}); return
            if event_name not in METRIC_EVENTS:
                self.send_json(400, {'error': 'اسم المؤشر غير مسموح'}); return
            if not re.fullmatch(r'[A-Za-z0-9-]{8,64}', event_id):
                self.send_json(400, {'error': 'eventId غير صالح'}); return
            if not isinstance(properties, dict) or len(properties) > 16:
                self.send_json(400, {'error': 'خصائص المؤشر غير صالحة'}); return
            clean_properties = {}
            for key, value in properties.items():
                if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,39}', str(key)):
                    self.send_json(400, {'error': 'اسم خاصية غير صالح'}); return
                if isinstance(value, bool) or value is None:
                    clean_properties[str(key)] = value
                elif isinstance(value, (int, float)) and not isinstance(value, bool):
                    clean_properties[str(key)] = value
                elif isinstance(value, str) and len(value) <= 80:
                    clean_properties[str(key)] = value
                else:
                    self.send_json(400, {'error': 'قيمة خاصية غير صالحة'}); return
            if not metric_properties_are_safe(event_name, clean_properties):
                self.send_json(400, {'error': 'خصائص المؤشر غير مسموحة'}); return
            if rate_limited(f'metric:{uid}', 300, 600):
                self.send_json(429, {'error': 'طلبات كثيرة جداً'}); return
            metric_record = {
                'event_id': event_id,
                'uid': uid,
                'event_name': event_name,
                'properties': clean_properties,
                'app_version': app_version,
                'created_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            }
            try:
                durable_write(f'users/{uid}/game_events/{event_id}', metric_record, merge=False)
            except Exception as exc:
                print(f'[Metrics] durable write failed event={event_id}: {exc}')
                self.send_json(503, {'error': 'تعذّر حفظ المؤشر بأمان'}); return
            conn = db_connect()
            try:
                conn.execute('''
                    INSERT OR IGNORE INTO game_events
                    (event_id, uid, event_name, properties, app_version)
                    VALUES (?,?,?,?,?)
                ''', (event_id, uid, event_name,
                      json.dumps(clean_properties, ensure_ascii=False, separators=(',', ':')),
                      app_version))
                conn.commit()
            finally:
                conn.close()
            self.send_json(202, {'ok': True})

        elif path == '/api/ios-diagnostics':
            try: data = json.loads(body)
            except Exception: self.send_json(400, {'error': 'JSON غير صالح'}); return
            uid = str(data.get('uid') or '').strip()
            id_token = str(data.get('idToken') or bearer_token(self.headers) or '').strip()
            report_id = str(data.get('reportId') or '').strip()
            report_type = str(data.get('reportType') or '').strip()
            payload = str(data.get('payload') or '')
            app_version = str(data.get('appVersion') or '').strip()[:40]
            if not uid or not uid_matches_token(uid, id_token):
                self.send_json(401, {'error': 'رمز الدخول غير صالح — سجّل دخولك مرة أخرى'}); return
            if (not re.fullmatch(r'[A-Za-z0-9-]{20,64}', report_id)
                    or report_type not in {'metric', 'diagnostic'}
                    or not payload or len(payload.encode()) > 512_000):
                self.send_json(400, {'error': 'تقرير iOS غير صالح'}); return
            if rate_limited(f'ios-diagnostics:{uid}', 40, 3600):
                self.send_json(429, {'error': 'طلبات تقارير كثيرة جداً'}); return
            record = {
                'report_id': report_id,
                'uid': uid,
                'report_type': report_type,
                'payload': payload,
                'app_version': app_version,
                'created_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            }
            try:
                durable_write(f'users/{uid}/ios_diagnostics/{report_id}', record, merge=False)
            except Exception as exc:
                print(f'[MetricKit] durable write failed report={report_id}: {exc}')
                self.send_json(503, {'error': 'تعذّر حفظ تقرير التشخيص بأمان'}); return
            conn = db_connect()
            try:
                conn.execute('''INSERT OR IGNORE INTO ios_diagnostics
                    (report_id, uid, report_type, payload, app_version)
                    VALUES (?,?,?,?,?)''',
                    (report_id, uid, report_type, payload, app_version))
                conn.commit()
            finally:
                conn.close()
            self.send_json(202, {'ok': True, 'reportId': report_id})

        elif path == '/api/questions/seen':
            try: data = json.loads(body)
            except Exception: self.send_json(400, {'error': 'JSON غير صالح'}); return
            uid = str(data.get('uid') or '').strip()
            id_token = str(data.get('idToken') or bearer_token(self.headers) or '').strip()
            raw_items = data.get('items') or []
            if not uid:
                self.send_json(400, {'error': 'uid مطلوب'}); return
            if not uid_matches_token(uid, id_token):
                self.send_json(401, {'error': 'رمز الدخول غير صالح — سجّل دخولك مرة أخرى'}); return
            if not isinstance(raw_items, list) or not raw_items or len(raw_items) > 100:
                self.send_json(400, {'error': 'items يجب أن تحتوي من 1 إلى 100 سؤال'}); return
            if rate_limited(f'question-seen:{uid}', 240, 600):
                self.send_json(429, {'error': 'طلبات كثيرة جداً — حاول بعد قليل'}); return
            clean_items = []
            seen_in_request = set()
            for item in raw_items:
                if not isinstance(item, dict):
                    self.send_json(400, {'error': 'عنصر سؤال غير صالح'}); return
                question_id = str(item.get('id') or '').strip()
                category = str(item.get('category') or '').strip()
                if (not re.fullmatch(r'[A-Za-z0-9._-]{1,128}', question_id)
                        or not category or len(category) > 80
                        or any(ord(char) < 32 for char in category)):
                    self.send_json(400, {'error': 'معرّف سؤال أو فئة غير صالح'}); return
                if question_id in seen_in_request:
                    continue
                seen_in_request.add(question_id)
                clean_items.append((uid, question_id, category))
            now_iso = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            if firestore_durable_available():
                try:
                    firestore_batch_set_documents([
                        (f'users/{uid}/question_seen/{question_id}', {
                            'uid': uid,
                            'question_id': question_id,
                            'category': category,
                            'seen_at': now_iso,
                        })
                        for _, question_id, category in clean_items
                    ])
                except Exception as exc:
                    print(f'[Question Seen] durable batch failed uid={uid}: {exc}')
                    self.send_json(503, {'error': 'تعذّر حفظ سجل الأسئلة بأمان'}); return
            elif durable_storage_required():
                self.send_json(503, {'error': 'التخزين الدائم غير مهيأ'}); return
            conn = db_connect()
            try:
                conn.executemany('''
                    INSERT INTO question_seen (uid, question_id, category)
                    VALUES (?, ?, ?)
                    ON CONFLICT(uid, question_id) DO UPDATE SET
                        category=excluded.category,
                        seen_at=CURRENT_TIMESTAMP
                ''', clean_items)
                conn.commit()
            finally:
                conn.close()
            self.send_json(200, {'ok': True, 'saved': len(clean_items)})

        # ─── حذف الحساب: إزالة كل بيانات المستخدم المرتبطة بالـ uid ──────────
        elif path == '/api/account/delete':
            try:   data = json.loads(body)
            except Exception: self.send_json(400, {'error': 'JSON غير صالح'}); return

            uid      = (data.get('uid')     or '').strip()
            id_token = (data.get('idToken') or '').strip()
            if not uid: self.send_json(400, {'error': 'uid مطلوب'}); return

            # تحقّق من هوية الطالب — يمنع حذف حساب شخص آخر (بديل Firestore Rules)
            if not uid_matches_token(uid, id_token):
                self.send_json(401, {'error': 'رمز الدخول غير صالح — سجّل دخولك مرة أخرى'}); return

            conn = None
            try:
                conn = db_connect()
                # بعض الجداول القديمة لا تُنشأ في كل تثبيت جديد؛ احذف فقط
                # الجداول الموجودة فعلاً حتى يبقى endpoint متوافقاً مع الهجرة.
                candidates = (
                    'subscriptions',
                    'promo_redemptions',
                    'revenuecat_identities',
                    'revenuecat_events',
                    'archived_stats',
                    'family_categories',
                    'player_stats',
                    'seen_questions',
                    'question_seen',
                    'free_rounds',
                    'question_reports',
                    'game_events',
                    'ios_diagnostics',
                    'subscription_outbox',
                )
                present = {
                    row[0] for row in conn.execute(
                        "SELECT name FROM sqlite_master "
                        "WHERE type='table' AND name IN ({})".format(
                            ','.join('?' for _ in candidates)
                        ),
                        candidates,
                    ).fetchall()
                }
                local_rc_app_user_id = None
                if 'revenuecat_identities' in present:
                    identity_row = conn.execute(
                        'SELECT rc_app_user_id FROM revenuecat_identities WHERE uid=?',
                        (uid,),
                    ).fetchone()
                    local_rc_app_user_id = identity_row[0] if identity_row else None
                deleted = {}
                for table in candidates:
                    if table not in present:
                        continue
                    if table == 'revenuecat_events' and local_rc_app_user_id:
                        cur = conn.execute(
                            'DELETE FROM revenuecat_events '
                            'WHERE uid=? OR rc_ids LIKE ?',
                            (uid, f'%"{local_rc_app_user_id}"%'),
                        )
                    else:
                        cur = conn.execute(
                            f'DELETE FROM "{table}" WHERE uid=?',
                            (uid,)
                        )
                    deleted[table] = cur.rowcount

                # لا نعلن نجاحاً محلياً قبل حذف النسخة السحابية. تبقى
                # المعاملة مفتوحة وقابلة للتراجع إذا تعذر Firestore.
                try:
                    firestore_delete_subscription(uid)
                except Exception as exc:
                    conn.rollback()
                    print(f'[Account Delete] فشل حذف Firestore uid={uid}: {exc}')
                    self.send_json(503, {
                        'error': 'تعذّر حذف بيانات الحساب السحابية — حاول مرة أخرى'
                    })
                    return

                conn.commit()
                self.send_json(200, {'ok': True, 'deleted': deleted})
            except sqlite3.OperationalError:
                if conn is not None:
                    conn.rollback()
                self.send_json(503, {
                    'error': 'قاعدة البيانات مشغولة — حاول بعد لحظات'
                })
            finally:
                if conn is not None:
                    conn.close()

        # ─── حفظ بيانات الملف الشخصي بشكل دائم (خصوصاً بريد/اسم Apple الذي
        # لا يُرسَل إلا مرة واحدة عند أول تفويض) ─────────────────────────────
        elif path == '/api/account/profile':
            try:   data = json.loads(body)
            except Exception: self.send_json(400, {'error': 'JSON غير صالح'}); return

            uid      = (data.get('uid')     or '').strip()
            name     = (data.get('name')    or '').strip()[:60]
            email    = (data.get('email')   or '').strip()[:200]
            provider = (data.get('provider') or '').strip()[:30]
            id_token = (data.get('idToken') or '').strip()
            if not uid: self.send_json(400, {'error': 'uid مطلوب'}); return

            if not uid_matches_token(uid, id_token):
                self.send_json(401, {'error': 'رمز الدخول غير صالح — سجّل دخولك مرة أخرى'}); return

            try:
                profile = {
                    'uid': uid,
                    'updated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                }
                if email:
                    profile['email'] = email
                if name:
                    profile['display_name'] = name
                if provider:
                    profile['auth_provider'] = provider
                durable_write(f'subscriptions/{uid}', profile)
                conn = db_connect()
                conn.execute('''
                    INSERT INTO subscriptions (uid, email, display_name, auth_provider)
                    VALUES (?,?,?,?)
                    ON CONFLICT(uid) DO UPDATE SET
                        email        = CASE WHEN excluded.email        != '' THEN excluded.email        ELSE subscriptions.email END,
                        display_name = CASE WHEN excluded.display_name != '' THEN excluded.display_name ELSE subscriptions.display_name END,
                        auth_provider= CASE WHEN excluded.auth_provider!= '' THEN excluded.auth_provider ELSE subscriptions.auth_provider END
                ''', (uid, email, name, provider))
                conn.commit()
                conn.close()
                self.send_json(200, {'ok': True})
            except sqlite3.OperationalError:
                self.send_json(503, {'error': 'قاعدة البيانات مشغولة — حاول بعد لحظات'})
            except Exception as exc:
                print(f'[Profile] durable write failed uid={uid}: {exc}')
                self.send_json(503, {'error': 'تعذّر حفظ الملف الشخصي بأمان'})

        # ─── ربط RevenueCat UUID بحساب Firebase ─────────────────────────────
        elif path == '/api/revenuecat/identity':
            try:
                data = json.loads(body)
            except Exception:
                self.send_json(400, {'error': 'JSON غير صالح'}); return

            uid = (data.get('uid') or '').strip()
            rc_app_user_id = (data.get('rcAppUserId') or '').strip().lower()
            id_token = (data.get('idToken') or '').strip()
            if not uid or not is_valid_rc_app_user_id(rc_app_user_id):
                self.send_json(400, {'error': 'UUID RevenueCat غير صالح'}); return
            if not uid_matches_token(uid, id_token):
                self.send_json(401, {'error': 'رمز الدخول غير صالح — سجّل دخولك مرة أخرى'}); return

            if firestore_durable_available():
                try:
                    claimed_document = firestore_get_document(
                        f'revenuecat_identities/{rc_app_user_id}')
                    if claimed_document and claimed_document.get('uid') != uid:
                        self.send_json(409, {'error': 'هوية RevenueCat مرتبطة بحساب آخر'}); return
                    now_iso = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
                    firestore_batch_set_documents([
                        (f'revenuecat_identities/{rc_app_user_id}', {
                            'uid': uid,
                            'rc_app_user_id': rc_app_user_id,
                            'updated_at': now_iso,
                        }),
                        (f'revenuecat_users/{uid}', {
                            'uid': uid,
                            'rc_app_user_id': rc_app_user_id,
                            'updated_at': now_iso,
                        }),
                    ])
                except Exception as exc:
                    print(f'[RevenueCat] identity durable write failed uid={uid}: {exc}')
                    self.send_json(503, {'error': 'تعذّر حفظ ربط الاشتراك بأمان'}); return
            elif durable_storage_required():
                self.send_json(503, {'error': 'التخزين الدائم غير مهيأ'}); return

            conn = db_connect()
            try:
                claimed = conn.execute(
                    'SELECT uid FROM revenuecat_identities WHERE rc_app_user_id=?',
                    (rc_app_user_id,)).fetchone()
                if claimed and claimed[0] != uid:
                    self.send_json(409, {'error': 'هوية RevenueCat مرتبطة بحساب آخر'}); return
                conn.execute('''
                    INSERT INTO revenuecat_identities (uid, rc_app_user_id)
                    VALUES (?,?)
                    ON CONFLICT(uid) DO UPDATE SET
                        rc_app_user_id=excluded.rc_app_user_id,
                        updated_at=CURRENT_TIMESTAMP
                ''', (uid, rc_app_user_id))
                conn.commit()
            finally:
                conn.close()
            replayed = 0
            if firestore_durable_available():
                try:
                    replayed = replay_pending_revenuecat_events(rc_app_user_id)
                except Exception as exc:
                    # الربط محفوظ؛ سيعيد webhook أو نداء الربط القادم المعالجة.
                    print(f'[RevenueCat] pending replay failed rc={rc_app_user_id}: {exc}')
            self.send_json(200, {'ok': True, 'replayed': replayed})


        elif path == '/api/revenuecat/webhook':
            # المصادقة: يُرفض الطلب إذا لم يُهيَّأ السر أو لم يطابق
            rc_secret = os.environ.get('REVENUECAT_WEBHOOK_SECRET', '')
            if not rc_secret:
                print('[RevenueCat] REVENUECAT_WEBHOOK_SECRET غير مهيَّأ — الـ endpoint معطَّل')
                self.send_json(503, {'error': 'Webhook غير مهيَّأ — تواصل مع المسؤول'}); return
            import hmac as _hmac
            auth_val = self.headers.get('Authorization', '') or ''
            # نقبل القيمة الخام أو بصيغة "Bearer <secret>" (كما يرسلها RevenueCat
            # حسب ما يُدخله المستخدم في حقل Authorization header value)
            candidate = auth_val[len('Bearer '):].strip() if auth_val.startswith('Bearer ') else auth_val
            if not (_hmac.compare_digest(candidate, rc_secret)
                    or _hmac.compare_digest(auth_val, rc_secret)):
                self.send_json(401, {'error': 'Unauthorized'}); return

            try:   event = json.loads(body)
            except Exception: self.send_json(400, {'error': 'JSON غير صالح'}); return
            try:
                status, response = process_revenuecat_event(event)
                self.send_json(status, response)
            except Exception as exc:
                # RevenueCat يعيد أحداث 5xx بنفس event.id؛ لا نُرجع 2xx قبل
                # اكتمال الكتابة الدائمة حتى لا يضيع الاستحقاق.
                print(f'[RevenueCat] durable processing failed: {exc}')
                self.send_json(503, {'error': 'تعذّرت معالجة الحدث بأمان — ستتم إعادة المحاولة'})

        else:
            self.send_response(404); self.end_headers()

def _firestore_get_token():
    """احصل على access token لـ Firestore REST API عبر Service Account (openssl)."""
    sa_json = (
        os.environ.get('FIREBASE_SERVICE_ACCOUNT_JSON', '')
        or os.environ.get('FIREBASE_SERVICE_ACCOUNT', '')
    )
    if not sa_json:
        return None, 'FIREBASE_SERVICE_ACCOUNT_JSON غير محدد'
    try:
        import base64 as _b64, time as _time, subprocess, tempfile, os as _os
        sa = json.loads(sa_json)
        configured_project = os.environ.get('FIREBASE_PROJECT_ID', '').strip()
        service_project = (sa.get('project_id') or '').strip()
        if (configured_project and service_project
                and configured_project != service_project):
            return None, 'FIREBASE_PROJECT_ID لا يطابق project_id داخل حساب الخدمة'
        header    = _b64.urlsafe_b64encode(json.dumps({'alg':'RS256','typ':'JWT'}).encode()).rstrip(b'=')
        now       = int(_time.time())
        claim     = _b64.urlsafe_b64encode(json.dumps({
            'iss':   sa['client_email'],
            'scope': 'https://www.googleapis.com/auth/datastore',
            'aud':   'https://oauth2.googleapis.com/token',
            'iat':   now,
            'exp':   now + 3600,
        }).encode()).rstrip(b'=')
        signing_input = header + b'.' + claim
        with tempfile.NamedTemporaryFile(delete=False, suffix='.pem') as f:
            f.write(sa['private_key'].encode())
            pem_path = f.name
        try:
            result = subprocess.run(
                ['openssl', 'dgst', '-sha256', '-sign', pem_path],
                input=signing_input, capture_output=True)
            sig = _b64.urlsafe_b64encode(result.stdout).rstrip(b'=')
        finally:
            _os.unlink(pem_path)
        jwt_token = (signing_input + b'.' + sig).decode()
        post_data = urllib.parse.urlencode({
            'grant_type': 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            'assertion':  jwt_token,
        }).encode()
        req = urllib.request.Request(
            'https://oauth2.googleapis.com/token',
            data=post_data,
            headers={'Content-Type': 'application/x-www-form-urlencoded'})
        with urllib.request.urlopen(req, timeout=15) as resp:
            tok = json.loads(resp.read())
        return tok.get('access_token'), None
    except Exception as e:
        return None, str(e)

def _firestore_http_error(exc, operation='request'):
    """استخرج رسالة Google المفيدة من HTTPError دون تسجيل أي اعتماد سري."""
    if not isinstance(exc, urllib.error.HTTPError):
        return f'Firestore {operation} error: {exc}'
    try:
        raw = exc.read().decode('utf-8', errors='replace')
        details = json.loads(raw).get('error') or {}
        status = details.get('status') or ''
        message = details.get('message') or raw[:240]
        reason = ''
        for item in details.get('details') or []:
            if item.get('@type', '').endswith('ErrorInfo'):
                reason = item.get('reason') or ''
                break
        suffix = f' ({reason})' if reason else ''
        return f'Firestore HTTP {exc.code}: {status or "HTTP_ERROR"}: {message}{suffix}'
    except Exception:
        return f'Firestore HTTP {exc.code}: تعذّر قراءة تفاصيل الخطأ'

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

# ─── حالة بدء التشغيل (تُستخدم في /api/admin/db-status) ────────────────────
import datetime as _dt, threading as _threading

_startup_status: dict = {
    'started_at':         None,
    'subscription_count': 0,
    'firestore_restore':  None,   # 'ok' | 'failed' | 'not_configured'
    'firestore_error':    None,
    'firestore_restored': 0,
    'firestore_source':   0,
    'warning':            None,
}

# ─── Outbox: تخزين مؤقت لعمليات Firestore الفاشلة ──────────────────────────
def init_outbox_table():
    """أنشئ جدول outbox لتتبّع عمليات الكتابة المعلّقة على Firestore."""
    conn = db_connect()
    conn.execute('''
        CREATE TABLE IF NOT EXISTS subscription_outbox (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            uid         TEXT NOT NULL,
            payload     TEXT NOT NULL,
            attempts    INTEGER DEFAULT 0,
            last_error  TEXT,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
            next_retry  DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    conn.commit()
    conn.close()

def enqueue_outbox(uid: str, payload: dict):
    """أضف سجل اشتراك إلى الـ outbox ليُعاد إرساله إلى Firestore لاحقاً."""
    try:
        conn = db_connect()
        enqueue_outbox_on_connection(conn, uid, payload)
        conn.commit()
        conn.close()
    except Exception as e:
        print(f'[OUTBOX] تعذّر الإضافة إلى الـ outbox: {e}')

def enqueue_outbox_on_connection(conn, uid: str, payload: dict):
    """نسخة من enqueue_outbox تستخدم معاملة قائمة لضمان ذرية تحديث الاشتراك."""
    conn.execute(
        'INSERT OR REPLACE INTO subscription_outbox (uid, payload, attempts) VALUES (?,?,0)',
        (uid, json.dumps(payload, ensure_ascii=False)))

def _firestore_write_subscription(uid: str, payload: dict, token: str, project_id: str):
    """يكتب سجل اشتراك واحد إلى Firestore REST API."""
    def fs_val(v):
        if isinstance(v, bool):
            return {'booleanValue': v}
        return {'stringValue': str(v)} if v else {'nullValue': None}
    known_fields = (
        'uid', 'email', 'display_name', 'auth_provider', 'status',
        'expires_at', 'updated_at',
    )
    fields = {key: fs_val(payload[key]) for key in known_fields if key in payload}
    fields.setdefault('uid', fs_val(payload.get('uid', uid)))
    body = json.dumps({'fields': fields}).encode()
    # حدّث الحقول الموجودة في الحمولة فقط من دون مسح بقية الوثيقة.
    query = urllib.parse.urlencode(
        [('updateMask.fieldPaths', key) for key in fields], doseq=True)
    url  = (f'https://firestore.googleapis.com/v1/projects/{project_id}'
            f'/databases/{firestore_database_path()}/documents/subscriptions/{urllib.parse.quote(uid)}'
            f'?{query}')
    req  = urllib.request.Request(url, data=body, method='PATCH',
           headers={'Authorization': f'Bearer {token}',
                    'Content-Type':  'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
    except urllib.error.HTTPError as exc:
        raise RuntimeError(_firestore_http_error(exc, 'write')) from exc

def _fs_write_from_payload(uid: str, payload: dict):
    """يكتب سجل اشتراك واحد إلى Firestore مستخدِماً FIREBASE_SERVICE_ACCOUNT_JSON."""
    sa_json_str = os.environ.get('FIREBASE_SERVICE_ACCOUNT_JSON', '')
    project_id  = os.environ.get('FIREBASE_PROJECT_ID', '')
    if not sa_json_str or not project_id:
        raise RuntimeError('FIREBASE_SERVICE_ACCOUNT_JSON أو FIREBASE_PROJECT_ID غير محدد')
    sa_json = json.loads(sa_json_str)
    token   = _get_gsa_access_token(sa_json)
    def fs_val(v):
        if isinstance(v, bool):
            return {'booleanValue': v}
        return {'stringValue': str(v)} if v else {'nullValue': None}
    fields = {k: fs_val(payload[k]) for k in (
        'uid', 'email', 'display_name', 'auth_provider', 'status',
        'expires_at', 'updated_at'
    ) if k in payload}
    fields.setdefault('uid', fs_val(payload.get('uid', uid)))
    body = json.dumps({'fields': fields}).encode()
    url  = (f'https://firestore.googleapis.com/v1/projects/{project_id}'
            f'/databases/{firestore_database_path()}/documents/subscriptions/{urllib.parse.quote(uid)}')
    req = urllib.request.Request(url, data=body, method='PATCH',
          headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
    except urllib.error.HTTPError as exc:
        raise RuntimeError(_firestore_http_error(exc, 'write')) from exc

def _outbox_worker():
    """خيط خلفي يُعيد إرسال السجلات المعلّقة في الـ outbox إلى Firestore."""
    import time as _time
    project_id = os.environ.get('FIREBASE_PROJECT_ID', '')
    if not project_id:
        return
    while True:
        _time.sleep(60)
        try:
            conn = db_connect()
            rows = conn.execute(
                "SELECT id, uid, payload, attempts FROM subscription_outbox "
                "WHERE attempts < 10 AND next_retry <= datetime('now') "
                "ORDER BY id LIMIT 50").fetchall()
            conn.close()
        except Exception:
            continue
        if not rows:
            continue
        token, err = _firestore_get_token()
        if not token:
            print(f'[OUTBOX] تعذّر الحصول على token: {err}')
            continue
        for row_id, uid, payload_json, attempts in rows:
            try:
                payload = json.loads(payload_json)
                _firestore_write_subscription(uid, payload, token, project_id)
                conn = db_connect()
                conn.execute('DELETE FROM subscription_outbox WHERE id=?', (row_id,))
                conn.commit()
                conn.close()
                print(f'[OUTBOX] ✅ أُرسل uid={uid} إلى Firestore بنجاح.')
            except Exception as e:
                delay = min(2 ** attempts * 60, 3600)
                conn = db_connect()
                conn.execute(
                    "UPDATE subscription_outbox SET attempts=attempts+1, last_error=?, "
                    "next_retry=datetime('now','+'||?||' seconds') WHERE id=?",
                    (str(e)[:500], delay, row_id))
                conn.commit()
                conn.close()
                print(f'[OUTBOX] ❌ فشل uid={uid} (محاولة {attempts+1}): {e}')

# ─── مزامنة Firestore عند بدء التشغيل ──────────────────────────────────────
def _upsert_docs_to_sqlite(docs):
    """يُدرج/يُحدّث قائمة وثائق Firestore في SQLite. يُعيد (count, error)."""
    conn  = db_connect()
    count = 0
    try:
        for doc in docs:
            fields = doc.get('fields') or {}
            def fv(key):
                f = fields.get(key) or {}
                return f.get('stringValue') or f.get('integerValue') or ''
            uid    = fv('uid') or (doc.get('name') or '').rsplit('/', 1)[-1]
            email  = fv('email')
            status = fv('status') or 'inactive'
            expires_at = fv('expires_at') or None
            display_name = fv('display_name') or None
            auth_provider = fv('auth_provider') or None
            if not uid:
                continue
            conn.execute('''INSERT INTO subscriptions
                (uid, email, display_name, auth_provider, status, expires_at)
                VALUES (?,?,?,?,?,?)
                ON CONFLICT(uid) DO UPDATE SET
                    email                  = excluded.email,
                    status                 = excluded.status,
                    display_name           = COALESCE(excluded.display_name, subscriptions.display_name),
                    auth_provider           = COALESCE(excluded.auth_provider, subscriptions.auth_provider),
                    expires_at              = excluded.expires_at,
                    updated_at             = CURRENT_TIMESTAMP''',
                (uid, email, display_name, auth_provider, status, expires_at))
            count += 1
        conn.commit()
        return count, None
    except Exception as e:
        try: conn.rollback()
        except Exception: pass
        return count, f'SQLite upsert error: {e}'
    finally:
        conn.close()

def _firestore_fetch_all_docs(project_id, token):
    """يجلب جميع وثائق مجموعة subscriptions من Firestore مع دعم التصفّح الكامل."""
    base = (f'https://firestore.googleapis.com/v1/projects/{project_id}'
            f'/databases/{firestore_database_path()}/documents/subscriptions')
    docs       = []
    page_token = None
    try:
        while True:
            url = base + '?pageSize=300'
            if page_token:
                url += f'&pageToken={urllib.parse.quote(page_token)}'
            req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read())
            docs.extend(data.get('documents') or [])
            page_token = data.get('nextPageToken')
            if not page_token:
                break
        return docs, None
    except Exception as e:
        return docs, _firestore_http_error(e, 'fetch')
def try_restore_from_firestore():
    """يجلب سجلات subscriptions من Firestore ويُدمجها في SQLite."""
    project_id = os.environ.get('FIREBASE_PROJECT_ID', '')
    if not project_id:
        return 0, 0, 'FIREBASE_PROJECT_ID غير محدد'
    token, err = _firestore_get_token()
    if not token:
        return 0, 0, f'JWT/token error: {err}'
    docs, fetch_err = _firestore_fetch_all_docs(project_id, token)
    source_total    = len(docs)
    if not docs:
        return 0, 0, fetch_err
    count, upsert_err = _upsert_docs_to_sqlite(docs)
    combined_err = ' | '.join(filter(None, [fetch_err, upsert_err])) or None
    return count, source_total, combined_err

def restore_pending_question_reports():
    """استعد outbox البريد من Firestore بعد أي إعادة تشغيل للحاوية."""
    if not firestore_durable_available():
        return 0
    documents = []
    for status in ('pending', 'pending_configuration', 'failed'):
        documents.extend(firestore_query_documents(
            'question_reports', 'email_status', status))
    if not documents:
        return 0
    conn = db_connect()
    try:
        for document in documents:
            report_id = document.get('report_id') or document.get('_document_id')
            conn.execute('''
                INSERT OR IGNORE INTO question_reports
                (report_id, uid, question_id, category, question_text,
                 answer_text, reason, details, app_version, email_status, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ''', (
                report_id,
                document.get('uid') or '',
                document.get('question_id') or '',
                document.get('category') or '',
                document.get('question_text') or '',
                document.get('answer_text') or '',
                document.get('reason') or 'other',
                document.get('details') or '',
                document.get('app_version') or '',
                document.get('email_status') or 'pending',
                document.get('created_at') or time.strftime('%Y-%m-%d %H:%M:%S'),
            ))
        conn.commit()
        return len(documents)
    finally:
        conn.close()

def _run_startup_recovery():
    """يُزامن من Firestore عند بدء التشغيل للتعافي من الفقد الجزئي."""
    global _startup_status
    _startup_status['started_at'] = _dt.datetime.now(_dt.timezone.utc).isoformat()
    try:
        conn   = db_connect()
        row    = conn.execute('SELECT COUNT(*) FROM subscriptions').fetchone()
        conn.close()
        before = row[0] if row else 0
    except Exception:
        before = 0
    _startup_status['subscription_count'] = before

    if not os.environ.get('FIREBASE_PROJECT_ID'):
        _startup_status['firestore_restore'] = 'not_configured'
        if before == 0:
            _startup_status['warning'] = (
                '🚨 تنبيه: قاعدة البيانات فارغة وFirestore غير مهيّأ. '
                'قد تكون الاشتراكات مفقودة — تحقق فوراً!')
            print(f'[STARTUP] {_startup_status["warning"]}')
        else:
            print(f'[STARTUP] Firestore غير مهيّأ — تعمل من قاعدة بيانات محلية ({before} سجل).')
        return

    mode = 'مزامنة كاملة' if before > 0 else 'استعادة (قاعدة فارغة)'
    print(f'[STARTUP] ⏳ {mode} من Firestore…')
    restored, source_total, err = try_restore_from_firestore()
    _startup_status['firestore_restored'] = restored
    _startup_status['firestore_source']   = source_total

    if err and restored == 0:
        _startup_status['firestore_restore'] = 'failed'
        _startup_status['firestore_error']   = err
        _startup_status['warning'] = (
            f'⚠️ تحذير: فشلت المزامنة مع Firestore ({err}). '
            f'الخادم يعمل من النسخة المحلية ({before} سجل).')
        print(f'[STARTUP] {_startup_status["warning"]}')
    else:
        _startup_status['firestore_restore'] = 'ok'
        if err:
            _startup_status['firestore_error'] = err
        try:
            conn  = db_connect()
            row   = conn.execute('SELECT COUNT(*) FROM subscriptions').fetchone()
            conn.close()
            after = row[0] if row else restored
        except Exception:
            after = restored
        _startup_status['subscription_count'] = after
        gained = after - before
        print(f'[STARTUP] ✅ {mode} اكتملت: {restored}/{source_total} سجل، '
              f'إجمالي محلي={after} (+{gained} جديد).')
    try:
        restored_reports = restore_pending_question_reports()
        if restored_reports:
            print(f'[STARTUP] استعيد {restored_reports} بلاغاً بانتظار التسليم.')
    except Exception as exc:
        print(f'[STARTUP] تعذّرت استعادة بلاغات البريد: {exc}')

# ─── تشغيل ───────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    init_db()
    init_outbox_table()
    _run_startup_recovery()
    _threading.Thread(target=_outbox_worker, daemon=True).start()
    _threading.Thread(target=_question_report_email_worker, daemon=True).start()
    server = ThreadedHTTPServer(('0.0.0.0', PORT), Handler)
    print(f'فطنة تعمل على http://0.0.0.0:{PORT}')
    server.serve_forever()
