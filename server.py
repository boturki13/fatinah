"""
خادم فطنة — Python خفيف مع Firebase Admin للتحقق المحلي من الرموز.
يخدم index.html وfirebase-config.js ويدير اشتراكات Apple IAP عبر RevenueCat.
أزيلت خدمات الأسئلة والفئات والتوليد من الإصدار 1.4.
"""
import base64, copy, datetime, gzip, hashlib, hmac, io, ipaddress, json, os, secrets, socket, sqlite3, threading, time, unicodedata, urllib.request, urllib.error, urllib.parse, uuid
import smtplib, ssl
from email.message import EmailMessage
from http.cookies import SimpleCookie
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
import re

import question_platform
import public_site

# ─── ثوابت ─────────────────────────────────────────────────────────────────
PORT      = int(os.environ.get('PORT', 5000))
APPLICATION_RELEASE = '1.4.0'
API_CONTRACT_REVISION = 'fatinah-v2-2026-09-08'
WWW_DIR   = os.path.join(os.path.dirname(__file__), "www")
HTML_FILE = os.path.join(WWW_DIR, "index.html")
DB_PATH   = os.environ.get(
    'FATINAH_DATABASE_PATH',
    os.path.join(os.path.dirname(__file__), 'subscriptions.db'),
)
IOS_DIAGNOSTIC_RETENTION_DAYS = 30
# Keep executable code behind explicit origins. Event-handler attributes are
# intentionally disabled; the client uses an allowlisted addEventListener
# dispatcher instead of requiring script-src 'unsafe-inline'.
WEB_CONTENT_SECURITY_POLICY = (
    "default-src 'self'; "
    "script-src 'self' https://www.gstatic.com; "
    "script-src-attr 'none'; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src 'self' https://fonts.gstatic.com; "
    "img-src 'self' data: blob:; "
    "connect-src 'self' https://ata20.com https://api.revenuecat.com "
    "https://identitytoolkit.googleapis.com https://securetoken.googleapis.com "
    "https://www.googleapis.com https://firestore.googleapis.com; "
    "object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
)
LEGAL_CONTENT_SECURITY_POLICY = (
    "default-src 'none'; "
    "script-src 'self'; script-src-attr 'none'; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src 'self' https://fonts.gstatic.com; "
    "img-src 'self' data:; "
    "frame-src 'none'; object-src 'none'; base-uri 'none'; "
    "form-action 'none'; frame-ancestors 'self'"
)


def bounded_env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    """Read an integer setting while preserving secure production bounds."""
    try:
        value = int(os.environ.get(name, default))
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(value, maximum))


# A finite read timeout releases slow/incomplete HTTP requests. A bounded worker
# count prevents unauthenticated clients from creating an unlimited number of
# handler threads. Both settings remain configurable inside conservative bounds.
HTTP_REQUEST_TIMEOUT_SECONDS = bounded_env_int(
    'FATINAH_HTTP_REQUEST_TIMEOUT_SECONDS', 15, 5, 30)
HTTP_MAX_WORKER_THREADS = bounded_env_int(
    'FATINAH_HTTP_MAX_WORKER_THREADS', 64, 8, 128)
# في Replit Deployment يصل الاتصال إلى التطبيق من طبقة البروكسي المُدارة.
# لذلك قد تشترك طلبات لاعبين مختلفين في عنوان TCP peer واحد، ولا يجوز أن
# نعامل هذا العنوان كأنه لاعب واحد ونخنق النسخة كلها بأربعة اتصالات. يبقى
# الحد العام للخيوط هو حاجز Slowloris الأساسي، ويصبح حد الـpeer مساوياً له
# في النشر فقط. محلياً يبقى الحد المحافظ 4 لاختبار الحماية من عميل مباشر.
IS_REPLIT_DEPLOYMENT = os.environ.get('REPLIT_DEPLOYMENT', '').strip() == '1'
HTTP_DEFAULT_CONNECTIONS_PER_PEER = (
    HTTP_MAX_WORKER_THREADS if IS_REPLIT_DEPLOYMENT else 4)
HTTP_MAX_CONNECTIONS_PER_IP = bounded_env_int(
    'FATINAH_HTTP_MAX_CONNECTIONS_PER_IP',
    HTTP_DEFAULT_CONNECTIONS_PER_PEER, 2, HTTP_MAX_WORKER_THREADS)
# Account deletion is destructive, so linked Firebase accounts must have
# reauthenticated shortly before the request. Keep the setting configurable for
# deployments, but never allow an accidentally large value to weaken the gate.
ACCOUNT_DELETE_MAX_AUTH_AGE_SECONDS = bounded_env_int(
    'FATINAH_ACCOUNT_DELETE_MAX_AUTH_AGE_SECONDS', 300, 60, 900)
ACCOUNT_DELETE_AUTH_CLOCK_SKEW_SECONDS = 60

def safe_log_reference(value) -> str:
    """بصمة قصيرة للسجلات؛ لا تطبع UID أو App User ID أو report ID خاماً."""
    text = str(value or '')
    if not text:
        return 'none'
    return hashlib.sha256(text.encode('utf-8')).hexdigest()[:12]

def exception_kind(exc: BaseException) -> str:
    """نوع ثابت قابل للتشخيص من دون message قد تحمل بيانات مستخدم/اعتماد."""
    return type(exc).__name__


ADMIN_SESSION_COOKIE = 'fatinah_quality_session'
ADMIN_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60
ADMIN_PASSWORD_ITERATIONS = 600_000
_question_platform_local_locks = tuple(threading.Lock() for _ in range(64))
_QUESTION_PLATFORM_LEASE_SECONDS = 30


def _stored_admin_credential():
    try:
        connection = sqlite3.connect(DB_PATH, timeout=5)
        row = connection.execute('''SELECT password_salt,password_hash,
            session_secret,iterations FROM admin_credentials WHERE id=1''').fetchone()
        connection.close()
        return row
    except sqlite3.Error:
        return None


def admin_password_configured() -> bool:
    return bool(os.environ.get('ADMIN_SECRET', '') or _stored_admin_credential())


def _admin_session_key() -> bytes:
    configured = os.environ.get('ADMIN_SECRET', '')
    if configured:
        return configured.encode('utf-8')
    row = _stored_admin_credential()
    return bytes(row[2]) if row and row[2] else b''


def verify_admin_password(password: str) -> bool:
    supplied = str(password or '')
    configured = os.environ.get('ADMIN_SECRET', '')
    if configured:
        return bool(supplied) and secrets.compare_digest(supplied, configured)
    row = _stored_admin_credential()
    if not row or not supplied:
        return False
    salt, expected, _, iterations = row
    actual = hashlib.pbkdf2_hmac(
        'sha256', supplied.encode('utf-8'), bytes(salt), int(iterations))
    return secrets.compare_digest(actual, bytes(expected))


def admin_password_issues(password: str):
    value = str(password or '')
    issues = []
    if len(value) < 12:
        issues.append('استخدم 12 خانة على الأقل')
    if len(value) > 128:
        issues.append('الحد الأقصى 128 خانة')
    if not any(character.isalpha() for character in value):
        issues.append('أضف حرفاً واحداً على الأقل')
    if not any(character.isdigit() for character in value):
        issues.append('أضف رقماً واحداً على الأقل')
    if not any(not character.isalnum() and not character.isspace()
               for character in value):
        issues.append('أضف رمزاً مثل ! أو #')
    return issues


def create_local_admin_password(password: str) -> None:
    """Create the one-time local credential; production stays environment-only."""
    issues = admin_password_issues(password)
    if issues:
        raise ValueError('، '.join(issues))
    if os.environ.get('ADMIN_SECRET', ''):
        raise RuntimeError('كلمة الإدارة مضبوطة من إعدادات الخادم')
    salt = secrets.token_bytes(32)
    digest = hashlib.pbkdf2_hmac(
        'sha256', password.encode('utf-8'), salt, ADMIN_PASSWORD_ITERATIONS)
    connection = sqlite3.connect(DB_PATH, timeout=10)
    try:
        connection.execute('BEGIN IMMEDIATE')
        if connection.execute(
                'SELECT 1 FROM admin_credentials WHERE id=1').fetchone():
            raise RuntimeError('تم إعداد كلمة الدخول مسبقاً')
        connection.execute('''INSERT INTO admin_credentials
            (id,password_salt,password_hash,session_secret,iterations,updated_at)
            VALUES (1,?,?,?,?,CURRENT_TIMESTAMP)''',
            (salt, digest, secrets.token_bytes(32), ADMIN_PASSWORD_ITERATIONS))
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def client_is_loopback(client_address) -> bool:
    try:
        host = str(client_address[0] if client_address else '').split('%', 1)[0]
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _admin_session_signature(timestamp: str) -> str:
    secret = _admin_session_key()
    return hmac.new(secret, f'fatinah-quality:{timestamp}'.encode('utf-8'),
                    hashlib.sha256).hexdigest()


def create_admin_session_cookie() -> str:
    timestamp = str(int(time.time()))
    token = f'{timestamp}.{_admin_session_signature(timestamp)}'
    secure = '; Secure' if deployment_environment() == 'production' else ''
    return (f'{ADMIN_SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; '
            f'Max-Age={ADMIN_SESSION_MAX_AGE_SECONDS}{secure}')


def clear_admin_session_cookie() -> str:
    secure = '; Secure' if deployment_environment() == 'production' else ''
    return (f'{ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; '
            f'Max-Age=0{secure}')


def admin_session_valid(headers) -> bool:
    secret = _admin_session_key()
    if not secret:
        return False
    cookie = SimpleCookie()
    try:
        cookie.load(headers.get('Cookie', '') or '')
        token = cookie.get(ADMIN_SESSION_COOKIE).value
        timestamp, signature = token.split('.', 1)
        issued_at = int(timestamp)
    except (AttributeError, KeyError, TypeError, ValueError):
        return False
    age = int(time.time()) - issued_at
    return (0 <= age <= ADMIN_SESSION_MAX_AGE_SECONDS
            and secrets.compare_digest(signature, _admin_session_signature(timestamp)))


def admin_origin_valid(headers) -> bool:
    origin = str(headers.get('Origin') or '').strip()
    if not origin:
        return deployment_environment() != 'production'
    try:
        parsed = urllib.parse.urlparse(origin)
    except ValueError:
        return False
    return parsed.scheme in {'http', 'https'} and parsed.netloc == headers.get('Host', '')


def question_access_allowed(uid: str) -> bool:
    """Subscribers and the one claimed introductory round may fetch packs."""
    if subscription_is_active(uid):
        return True
    connection = db_connect()
    try:
        row = connection.execute(
            'SELECT 1 FROM free_rounds WHERE uid=? LIMIT 1', (uid,)).fetchone()
        return bool(row)
    finally:
        connection.close()


def deliver_question_report_email(report: dict) -> str:
    """Deliver the complete internal snapshot without returning it to the app."""
    host = os.environ.get('SMTP_HOST', '').strip()
    sender = os.environ.get('SMTP_FROM', '').strip()
    if not host or not sender:
        return 'pending_configuration'
    question = report.get('question') or {}
    sources = question.get('sources') or []
    lines = [
        'بلاغ جديد عن سؤال في فطنة', '',
        f"معرف البلاغ: {report.get('report_id', '')}",
        f"حساب المبلّغ: {report.get('uid', '')}",
        f"الاسم: {report.get('reporter_name', '') or 'غير متوفر'}",
        f"البريد: {report.get('reporter_email', '') or 'غير متوفر'}", '',
        f"السبب: {report.get('reason', '')}",
        f"التفاصيل: {report.get('details', '') or 'لا يوجد'}", '',
        f"السؤال: {question.get('prompt', '')}",
        f"المستوى: {question.get('level', '')}",
        f"التصنيف الداخلي: {question.get('topic', '')}",
    ]
    for index, option in enumerate(question.get('options') or []):
        marker = ' (الإجابة الصحيحة)' if index == question.get('correctIndex') else ''
        lines.append(f'{index + 1}. {option}{marker}')
    lines.extend(['', f"سبب صحة الإجابة: {question.get('correctReason', '')}",
                  '', 'المصادر الداخلية:'])
    for source in sources:
        lines.append(f"- {source.get('title', '')}: {source.get('url', '')}")
    lines.extend(['', 'اختيارات اللاعبين:',
                  json.dumps(report.get('selections') or [], ensure_ascii=False, indent=2)])
    message = EmailMessage()
    message['Subject'] = f"بلاغ سؤال فطنة — {question.get('questionId', '')}"
    message['From'] = sender
    message['To'] = 'ata@ata20.com'
    message.set_content('\n'.join(lines))
    port = int(os.environ.get('SMTP_PORT', '587'))
    username = os.environ.get('SMTP_USERNAME', '').strip()
    password = os.environ.get('SMTP_PASSWORD', '')
    use_ssl = env_flag('SMTP_USE_SSL', False)
    if use_ssl:
        client = smtplib.SMTP_SSL(host, port, timeout=15,
                                  context=ssl.create_default_context())
    else:
        client = smtplib.SMTP(host, port, timeout=15)
    try:
        if not use_ssl and env_flag('SMTP_USE_TLS', True):
            client.starttls(context=ssl.create_default_context())
        if username:
            client.login(username, password)
        client.send_message(message)
    finally:
        client.quit()
    return 'sent'

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
    # اعتماد محلي أولي للوحة الجودة. في الإنتاج تبقى ADMIN_SECRET هي
    # الطريقة الإلزامية وتمنع نقطة الإعداد الذاتي تماماً.
    conn.execute('''
        CREATE TABLE IF NOT EXISTS admin_credentials (
            id              INTEGER PRIMARY KEY CHECK (id=1),
            password_salt   BLOB NOT NULL,
            password_hash   BLOB NOT NULL,
            session_secret  BLOB NOT NULL,
            iterations      INTEGER NOT NULL,
            updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
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
    # أزيل محتوى الأسئلة والفئات في 1.4؛ احذف أي بقايا نصوص أو فئات محلية.
    for removed_table in (
            "question_bank", "question_seen", "question_inventory_alerts",
            "question_reports"):
        conn.execute(f"DROP TABLE IF EXISTS {removed_table}")
    # جولة تعريفية واحدة لكل حساب. تسجيل الإكمال في الخادم يمنع إعادة فتحها
    # بمجرد مسح تخزين التطبيق أو الانتقال إلى جهاز آخر.
    conn.execute('''
        CREATE TABLE IF NOT EXISTS free_rounds (
            uid          TEXT PRIMARY KEY,
            completed_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    free_round_columns = {
        row[1] for row in conn.execute('PRAGMA table_info(free_rounds)')
    }
    retired_payload_columns = {
        'question_round_entitled': '0',
        'question_round_request_hash': 'NULL',
        'question_round_payload': 'NULL',
    }
    for column, value in retired_payload_columns.items():
        if column in free_round_columns:
            conn.execute(f'UPDATE free_rounds SET {column}={value}')
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
            schema_version INTEGER,
            privacy_scope TEXT,
            report_type TEXT NOT NULL,
            payload     TEXT NOT NULL,
            app_version TEXT,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    for ddl in (
        "ALTER TABLE ios_diagnostics ADD COLUMN schema_version INTEGER",
        "ALTER TABLE ios_diagnostics ADD COLUMN privacy_scope TEXT",
    ):
        try: conn.execute(ddl)
        except sqlite3.OperationalError: pass
    conn.execute('CREATE INDEX IF NOT EXISTS idx_ios_diagnostics_uid_time ON ios_diagnostics(uid, created_at)')
    conn.execute(
        "DELETE FROM ios_diagnostics "
        "WHERE created_at < datetime('now', ?)",
        (f'-{IOS_DIAGNOSTIC_RETENTION_DAYS} days',),
    )
    # App Attest يربط المطالبة بمفتاح Secure Enclave ثابت للتثبيت، بدلاً من
    # الثقة برمزي DeviceCheck مستقلين لا يستطيع الخادم إثبات أنهما من الجهاز
    # نفسه. Firestore هو المرجع في production؛ هذه الجداول للاختبارات والكاش.
    conn.execute('''
        CREATE TABLE IF NOT EXISTS app_attest_challenges (
            challenge_id    TEXT PRIMARY KEY,
            uid_hash        TEXT NOT NULL,
            key_id_hash     TEXT NOT NULL,
            purpose         TEXT NOT NULL,
            client_data     TEXT NOT NULL,
            request_hash    TEXT NOT NULL DEFAULT '',
            expires_at      INTEGER NOT NULL,
            consumed_at     INTEGER
        )
    ''')
    challenge_columns = {
        row[1] for row in conn.execute(
            'PRAGMA table_info(app_attest_challenges)').fetchall()
    }
    desired_challenge_columns = {
        'challenge_id', 'uid_hash', 'key_id_hash', 'purpose', 'client_data',
        'request_hash', 'expires_at', 'consumed_at',
    }
    if challenge_columns != desired_challenge_columns:
        # التحديات عمرها خمس دقائق ولا يجوز ترحيل بياناتها المرتبطة بالحساب
        # من المخطط القديم. إسقاطها fail-closed ويجبر العميل على طلب تحدٍ جديد.
        conn.execute('DROP TABLE app_attest_challenges')
        conn.execute('''
            CREATE TABLE app_attest_challenges (
                challenge_id    TEXT PRIMARY KEY,
                uid_hash        TEXT NOT NULL,
                key_id_hash     TEXT NOT NULL,
                purpose         TEXT NOT NULL,
                client_data     TEXT NOT NULL,
                request_hash    TEXT NOT NULL DEFAULT '',
                expires_at      INTEGER NOT NULL,
                consumed_at     INTEGER
            )
        ''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_app_attest_challenges_expiry ON app_attest_challenges(expires_at)')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS app_attest_keys (
            key_id_hash     TEXT PRIMARY KEY,
            key_id          TEXT NOT NULL UNIQUE,
            public_key_pem  TEXT NOT NULL,
            receipt         TEXT NOT NULL,
            counter         INTEGER NOT NULL DEFAULT 0,
            environment     TEXT NOT NULL,
            attested_at     INTEGER NOT NULL
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS free_round_installations (
            key_id_hash TEXT PRIMARY KEY,
            owner_hash TEXT NOT NULL,
            state TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            completed_at INTEGER
        )
    ''')
    # المطالبة تبدأ pending قبل تغيير bit0 لدى Apple، ثم تصبح completed بعد
    # حفظ ربط الحساب. هكذا يستطيع الحساب نفسه إكمال المحاولة بعد فشل مؤقت،
    # بينما يبقى حساب آخر محجوباً. لا نخزن UID خاماً في سجل التثبيت.
    installation_columns = {
        row[1] for row in conn.execute(
            'PRAGMA table_info(free_round_installations)').fetchall()
    }
    desired_installation_columns = {
        'key_id_hash', 'owner_hash', 'state', 'created_at', 'updated_at',
        'completed_at',
    }
    if installation_columns != desired_installation_columns:
        conn.execute('DROP TABLE IF EXISTS free_round_installations_v13')
        conn.execute('''
            CREATE TABLE free_round_installations_v13 (
                key_id_hash TEXT PRIMARY KEY,
                owner_hash TEXT NOT NULL,
                state TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                completed_at INTEGER
            )
        ''')
        conn.execute('''
            INSERT OR IGNORE INTO free_round_installations_v13
            (key_id_hash, owner_hash, state, created_at, updated_at,
             completed_at)
            SELECT key_id_hash, '', 'completed',
                   COALESCE(completed_at, CAST(strftime('%s','now') AS INTEGER)),
                   COALESCE(completed_at, CAST(strftime('%s','now') AS INTEGER)),
                   completed_at
            FROM free_round_installations
        ''')
        conn.execute('DROP TABLE free_round_installations')
        conn.execute('''
            ALTER TABLE free_round_installations_v13
            RENAME TO free_round_installations
        ''')
    conn.commit()
    conn.close()
    question_platform.initialize(DB_PATH)

def normalize_topic(topic: str) -> str:
    """توحيد الموضوع: إزالة التشكيل والمسافات الزائدة وأل التعريف للمطابقة."""
    import re
    t = topic.strip().lower()
    t = re.sub(r'[\u064B-\u0652\u0670]', '', t)          # تشكيل
    t = t.replace('أ', 'ا').replace('إ', 'ا').replace('آ', 'ا').replace('ة', 'ه').replace('ى', 'ي')
    t = re.sub(r'\s+', ' ', t)
    return t

# ─── التحقق من هوية Firebase (نظام الهوية الموحّد — Task #70) ───────────────
# نتحقق من idToken عبر Admin SDK مع check_revoked، ونبقي Identity
# Toolkit REST كمسار توافق للعمليات غير المدمّرة. عند غياب إعداد Firebase
# يفشل التحقق مغلقاً؛ لا يوجد مسار يثق بـuid مرسل من العميل.
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
                # Preserve the signed authentication context for destructive
                # operations. Identity Toolkit's lookup response does not
                # expose these claims, so recent-auth checks fail closed when
                # the Admin SDK is unavailable.
                'authTime': decoded.get('auth_time'),
                'signInProvider': (
                    decoded.get('firebase', {}).get('sign_in_provider')
                    if isinstance(decoded.get('firebase'), dict) else None
                ),
            }
        except Exception as e:
            print(f'Admin ID token verify error: {exception_kind(e)}')
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
        print(f'ID token verify error: {exception_kind(e)}')
        return None

def verified_uid_token(uid: str, id_token: str):
    """أعد سياق الهوية الموثق عند تطابق uid، وارفض افتراضياً."""
    if not firebase_is_configured():
        print('WARNING: FIREBASE_PROJECT_ID غير مضبوط — رفض التحقق من الهوية (deny-by-default)')
        return None
    if not id_token:
        return None
    admin_configured = bool(
        os.environ.get('FIREBASE_SERVICE_ACCOUNT_JSON', '').strip()
    )
    if not admin_configured and not os.environ.get('GOOGLE_API_KEY', '').strip():
        print('WARNING: GOOGLE_API_KEY غير مضبوط — رفض التحقق من الهوية (deny-by-default)')
        return None
    verified = verify_firebase_id_token(id_token)
    if not verified or verified.get('localId') != uid:
        return None
    return verified


def uid_matches_token(uid: str, id_token: str) -> bool:
    """يتحقق أن uid المطلوب هو نفس صاحب idToken المرسَل. رفض افتراضي
    (deny-by-default) في أي حالة تعذّر فيها التحقق الفعلي. عند تهيئة
    Firebase Admin لا نحتاج GOOGLE_API_KEY؛ يُستخدم المفتاح العام فقط لمسار
    REST التوافقي عندما لا يتوفر مفتاح الخدمة. القبول بلا تحقق كان يعني أن
    أي طلب بـuid عشوائي يمرّ من كل نقطة نهاية "محمية"."""
    return bool(verified_uid_token(uid, id_token))


def authorize_account_delete(uid: str, id_token: str, *, api_version: str,
                             app_check_valid: bool, now: int | None = None):
    """أعد (allowed, code) لطلب حذف حساب مدمّر.

    الحساب المرتبط يحتاج auth_time حديثاً. Firebase Anonymous لا يملك
    credential لإعادة المصادقة؛ لذلك نسمح له بالحذف برمزه الموثق فقط
    عبر v2 وبعد تحقق App Check فعلي، حتى لو كان الإنفاذ العام في وضع مراقبة.
    """
    verified = verified_uid_token(uid, id_token)
    if not verified:
        return False, 'invalid_auth_token'

    if verified.get('signInProvider') == 'anonymous':
        if api_version == '2' and app_check_valid:
            return True, 'anonymous_app_check'
        return False, 'anonymous_app_check_required'

    auth_time = verified.get('authTime')
    if isinstance(auth_time, bool):
        return False, 'recent_auth_required'
    try:
        auth_time = int(auth_time)
    except (TypeError, ValueError, OverflowError):
        return False, 'recent_auth_required'
    current_time = int(time.time()) if now is None else int(now)
    age = current_time - auth_time
    if (age < -ACCOUNT_DELETE_AUTH_CLOCK_SKEW_SECONDS
            or age > ACCOUNT_DELETE_MAX_AUTH_AGE_SECONDS):
        return False, 'recent_auth_required'
    return True, 'recent_auth'


# ─── عزل عقود API والبيئات ──────────────────────────────────────────────────
# المسارات غير المرقمة تبقى v1 حفاظاً على تطبيق 1.2. يمكن لتطبيق 1.3 اختيار
# v2 إما بالمسار /api/v2/... أو بالرأس X-Fatinah-API-Version: 2. لا نستنتج
# النسخة من User-Agent أو App Check لأن كليهما غير مضمون أثناء الطرح التدريجي.
API_VERSION_HEADER = 'X-Fatinah-API-Version'
DEPLOYMENT_ENVIRONMENTS = {'local', 'staging', 'production'}
PRODUCTION_BACKEND_HOSTS = {
    'ata20.com',
    'www.ata20.com',
    'us-central1-fatinah-game.cloudfunctions.net',
}
def configured_deployment_environment():
    """يعيد البيئة المصرح بها صراحةً، أو None عند الغياب/الخطأ."""
    raw = os.environ.get('FATINAH_ENVIRONMENT')
    if raw is None or not raw.strip():
        return None
    value = raw.strip().lower()
    aliases = {
        'dev': 'local', 'development': 'local',
        'stage': 'staging', 'prod': 'production',
    }
    value = aliases.get(value, value)
    return value if value in DEPLOYMENT_ENVIRONMENTS else None


def deployment_environment() -> str:
    raw = os.environ.get('FATINAH_ENVIRONMENT')
    if raw is None or not raw.strip():
        return 'unconfigured'
    value = configured_deployment_environment()
    return value or 'invalid'


def public_web_game_enabled() -> bool:
    """لا تعرض حزمة اللعبة إلا في بيئة تطوير/اختبار معلنة صراحةً."""
    return configured_deployment_environment() in {'local', 'staging'}


def env_flag(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None or not value.strip():
        return default
    return value.strip().lower() in ('1', 'true', 'yes', 'on', 'enabled')


def _single_api_version_header(headers) -> str:
    if hasattr(headers, 'get_all'):
        values = headers.get_all(API_VERSION_HEADER) or []
    else:
        value = headers.get(API_VERSION_HEADER, '')
        values = [] if value is None or value == '' else [value]
    # نرفض التكرار حتى لو تطابقت القيم؛ بعض الوسطاء يختار الأول وبعضهم الأخير.
    if len(values) > 1:
        raise ValueError('تكرر رأس نسخة API')
    value = str(values[0] if values else '').strip().lower()
    if ',' in value:
        raise ValueError('رأس نسخة API مركّب وغير مدعوم')
    return value


def resolve_api_contract(path: str, headers) -> tuple[str, str]:
    """يعيد (المسار الداخلي، النسخة)، ويرفض تعارض المسار مع الرأس."""
    explicit_version = None
    canonical_path = path
    for version in ('1', '2'):
        prefix = f'/api/v{version}'
        if path == prefix:
            explicit_version = version
            canonical_path = '/api'
            break
        if path.startswith(prefix + '/'):
            explicit_version = version
            canonical_path = '/api' + path[len(prefix):]
            break

    is_api_path = path == '/api' or path.startswith('/api/')
    requested = _single_api_version_header(headers) if is_api_path else ''
    if requested.startswith('v'):
        requested = requested[1:]
    if requested and requested not in ('1', '2'):
        raise ValueError('نسخة API غير مدعومة')
    if explicit_version and requested and explicit_version != requested:
        raise ValueError('نسخة API في المسار لا تطابق الرأس')

    # أي مسار API قديم بلا رقم يبقى v1. الرؤوس لا تؤثر في الملفات العامة.
    version = explicit_version or (requested if is_api_path else '1') or '1'
    return canonical_path, version


V2_ROUTE_FEATURES = {
    '/api/version': None,
    '/api/rc-config': None,
    '/api/auth/check-anonymous': None,
    '/api/subscription/status': None,
    '/api/account/delete': None,
    '/api/account/profile': None,
    '/api/revenuecat/identity': None,
    '/api/admin/db-status': None,
    '/api/admin/metrics': None,
    '/api/admin/session': 'question_admin',
    '/api/admin/setup-status': 'question_admin',
    '/api/admin/setup': 'question_admin',
    '/api/admin/login': 'question_admin',
    '/api/admin/logout': 'question_admin',
    '/api/admin/dashboard': 'question_admin',
    '/api/admin/questions': 'question_admin',
    '/api/admin/question-status': 'question_admin',
    '/api/admin/reports': 'question_admin',
    '/api/admin/report-status': 'question_admin',
    '/api/admin/audit': 'question_admin',
    '/api/app-attest/status': 'app_attest',
    '/api/app-attest/challenge': 'app_attest',
    '/api/app-attest/attest': 'app_attest',
    '/api/free-round/status': 'free_round',
    '/api/free-round/complete': 'free_round',
    '/api/metrics/event': 'metrics',
    '/api/ios-diagnostics': 'ios_diagnostics',
    '/api/revenuecat/webhook': 'revenuecat_webhook',
    '/api/game/packs/readiness': 'game_packs',
    '/api/game/packs/ensure': 'game_packs',
    '/api/game/packs/start': 'game_packs',
    '/api/game/packs/complete': 'game_packs',
    '/api/game/questions/report': 'question_reports',
}

REMOVED_CONTENT_ROUTES = frozenset({
    '/api/generate',
    '/api/admin/question-inventory',
    '/api/questions/catalog',
    '/api/questions/report',
    '/api/questions/reservations/release',
    '/api/questions/reveal',
    '/api/questions/round',
    '/api/questions/seen',
})

# هذه المسارات أضيفت لأول مرة في 1.3، ولا يوجد عميل 1.2 يحتاجها. إبقاؤها
# متاحة بعقد v1 يجعل نسخة API التي يختارها العميل وسيلة لتجاوز App Check أو
# App Attest أو DeviceCheck. لذلك يرفضها الخادم قبل الوصول إلى المعالج ما لم
# يكن العقد الفعلي v2.
V2_ONLY_ROUTES = {
    '/api/app-attest/status',
    '/api/app-attest/challenge',
    '/api/app-attest/attest',
    '/api/free-round/status',
    '/api/free-round/complete',
    '/api/metrics/event',
    '/api/game/packs/readiness',
    '/api/game/packs/ensure', '/api/game/packs/start',
    '/api/game/packs/complete', '/api/game/questions/report',
}


def v2_feature_enabled(feature: str) -> bool:
    """أعلام v2 صريحة في الإنتاج، ومفعلة افتراضياً محلياً وفي staging."""
    env_name = f'FATINAH_V2_FEATURE_{feature.upper()}_ENABLED'
    default = deployment_environment() in {'local', 'staging'}
    return env_flag(env_name, default)


def v1_revenuecat_bootstrap_enabled() -> bool:
    """السماح المؤقت لعميل 1.2 بإنشاء ربط UUID جديد.

    الربط القائم يعمل دائماً، أما bootstrap بمعرّف يختاره العميل
    فمغلق افتراضياً في كل البيئات، ويحتاج opt-in صريحاً ومؤقتاً
    لفترة الترحيل فقط.
    """
    return env_flag('FATINAH_V1_REVENUECAT_BOOTSTRAP_ENABLED', False)


APP_CHECK_PROTECTED_PATHS = {
    '/api/account/delete', '/api/account/profile',
    '/api/app-attest/status', '/api/app-attest/challenge',
    '/api/app-attest/attest',
    '/api/free-round/complete', '/api/free-round/status',
    '/api/metrics/event', '/api/ios-diagnostics',
    '/api/game/packs/readiness',
    '/api/game/packs/ensure', '/api/game/packs/start',
    '/api/game/packs/complete', '/api/game/questions/report',
    '/api/revenuecat/identity', '/api/subscription/status',
}

def app_check_enforcement_enabled(api_version: str = '1') -> bool:
    """لا نفرض App Check على v1 افتراضياً لأن تطبيق 1.2 لا يرسل الرمز."""
    version_key = f'FATINAH_V{api_version}_APP_CHECK_ENFORCE'
    if os.environ.get(version_key, '').strip():
        return env_flag(version_key)
    if api_version == '2':
        return env_flag('FIREBASE_APP_CHECK_ENFORCE', False)
    return False

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
        print(f'[App Check] verification failed path={path}: {exception_kind(exc)}')
        return False, 'invalid'


def app_attest_enforcement_enabled(api_version: str = '1') -> bool:
    """App Attest المباشر مطلوب لمطالبة العرض في v2 production.

    Firebase App Check يثبت سلامة التطبيق، لكنه لا يعطينا معرّف مفتاح ثابتاً
    نربط به جولة واحدة. لذلك نستخدم assertion مباشرًا فوق App Check.
    """
    version_key = f'FATINAH_V{api_version}_APP_ATTEST_ENFORCE'
    if os.environ.get(version_key, '').strip():
        return env_flag(version_key)
    return api_version == '2' and deployment_environment() == 'production'


def app_attest_identity() -> tuple[str, str, str]:
    """أعد App ID prefix وBundle ID وبيئة Apple المتوقعة."""
    prefix = os.environ.get('APPLE_APP_ATTEST_APP_ID_PREFIX', '').strip()
    bundle_id = os.environ.get('APPLE_APP_ATTEST_BUNDLE_ID', '').strip()
    environment = os.environ.get(
        'APPLE_DEVICECHECK_ENVIRONMENT', '').strip().lower()
    if not re.fullmatch(r'[A-Z0-9]{10}', prefix):
        raise DeviceCheckConfigurationError(
            'APPLE_APP_ATTEST_APP_ID_PREFIX غير صالح')
    if bundle_id != 'com.fatinah.game':
        raise DeviceCheckConfigurationError(
            'APPLE_APP_ATTEST_BUNDLE_ID لا يطابق التطبيق')
    if environment in {'development', 'sandbox'}:
        expected_environment = 'development'
    elif environment == 'production':
        expected_environment = 'production'
    else:
        raise DeviceCheckConfigurationError(
            'بيئة App Attest غير محددة')
    return prefix, bundle_id, expected_environment


class DeviceCheckConfigurationError(RuntimeError):
    """إعدادات خدمة DeviceCheck الخادمية ناقصة أو غير صالحة."""


class DeviceCheckServiceError(RuntimeError):
    """فشل مؤقت أو رفض من خدمة DeviceCheck لدى Apple."""


class DeviceCheckClaimBusyError(RuntimeError):
    """توجد مطالبة أخرى قيد التنفيذ؛ على العميل إعادة المحاولة."""


_devicecheck_claim_local_lock = threading.Lock()
_DEVICECHECK_CLAIM_LOCK_PATH = 'service_locks/devicecheck_free_round_claim'
_DEVICECHECK_CLAIM_LEASE_SECONDS = 120


def devicecheck_enforcement_enabled(api_version: str = '1') -> bool:
    """احمِ العرض المجاني على v2 في الإنتاج، مع سماح صريح للاختبارات المحلية.

    تطبيق 1.2 لا يرسل DeviceCheck token؛ لذلك لا يتغير عقد v1. أما 1.3
    (عقد v2) فيفشل مغلقاً في production إذا غابت مفاتيح Apple الخادمية.
    """
    version_key = f'FATINAH_V{api_version}_DEVICECHECK_ENFORCE'
    if os.environ.get(version_key, '').strip():
        return env_flag(version_key)
    return api_version == '2' and deployment_environment() == 'production'


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b'=').decode('ascii')


def _devicecheck_private_key_bytes() -> bytes:
    raw = os.environ.get('APPLE_DEVICECHECK_PRIVATE_KEY', '').strip()
    if not raw:
        raise DeviceCheckConfigurationError('APPLE_DEVICECHECK_PRIVATE_KEY مفقود')
    if 'BEGIN PRIVATE KEY' not in raw and 'BEGIN EC PRIVATE KEY' not in raw:
        try:
            raw = base64.b64decode(raw, validate=True).decode('utf-8')
        except Exception as exc:
            raise DeviceCheckConfigurationError(
                'APPLE_DEVICECHECK_PRIVATE_KEY ليس PEM أو Base64 صالحاً') from exc
    return raw.replace('\\n', '\n').encode('utf-8')


def devicecheck_auth_jwt(now: int | None = None) -> str:
    """أنشئ JWT ES256 قصير العمر لخدمة Apple من أسرار الخادم فقط."""
    key_id = os.environ.get('APPLE_DEVICECHECK_KEY_ID', '').strip()
    team_id = os.environ.get('APPLE_DEVICECHECK_TEAM_ID', '').strip()
    if not key_id or not team_id:
        raise DeviceCheckConfigurationError(
            'APPLE_DEVICECHECK_KEY_ID وAPPLE_DEVICECHECK_TEAM_ID مطلوبان')
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

        header = _base64url(json.dumps(
            {'alg': 'ES256', 'kid': key_id}, separators=(',', ':')
        ).encode('utf-8'))
        payload = _base64url(json.dumps(
            {'iss': team_id, 'iat': int(now if now is not None else time.time())},
            separators=(',', ':')
        ).encode('utf-8'))
        signing_input = f'{header}.{payload}'.encode('ascii')
        private_key = serialization.load_pem_private_key(
            _devicecheck_private_key_bytes(), password=None)
        if not isinstance(private_key, ec.EllipticCurvePrivateKey):
            raise ValueError('DeviceCheck key is not elliptic-curve')
        signature_der = private_key.sign(signing_input, ec.ECDSA(hashes.SHA256()))
        r, s = decode_dss_signature(signature_der)
        signature = r.to_bytes(32, 'big') + s.to_bytes(32, 'big')
        return f'{header}.{payload}.{_base64url(signature)}'
    except DeviceCheckConfigurationError:
        raise
    except Exception as exc:
        raise DeviceCheckConfigurationError('تعذّر تحميل مفتاح DeviceCheck') from exc


def _devicecheck_api_base() -> str:
    environment = os.environ.get('APPLE_DEVICECHECK_ENVIRONMENT', '').strip().lower()
    if environment in {'development', 'sandbox'}:
        return 'https://api.development.devicecheck.apple.com'
    if environment in {'', 'production'}:
        return 'https://api.devicecheck.apple.com'
    raise DeviceCheckConfigurationError('APPLE_DEVICECHECK_ENVIRONMENT غير صالح')


def devicecheck_request(operation: str, device_token: str, *, bit0=None, bit1=None) -> dict:
    """استعلم أو حدّث bit العرض المجاني باستخدام token جديد أحضره التطبيق."""
    token = (device_token or '').strip()
    if not token or '\n' in token or '\r' in token or len(token) > 4096:
        raise ValueError('DeviceCheck token غير صالح')
    if operation not in {'query_two_bits', 'update_two_bits'}:
        raise ValueError('عملية DeviceCheck غير مدعومة')
    payload = {
        'device_token': token,
        'transaction_id': str(uuid.uuid4()),
        'timestamp': int(time.time() * 1000),
    }
    if operation == 'update_two_bits':
        if bit0 is not None:
            payload['bit0'] = bool(bit0)
        if bit1 is not None:
            payload['bit1'] = bool(bit1)
    request = urllib.request.Request(
        f'{_devicecheck_api_base()}/v1/{operation}',
        data=json.dumps(payload, separators=(',', ':')).encode('utf-8'),
        method='POST',
        headers={
            'Authorization': f'Bearer {devicecheck_auth_jwt()}',
            'Content-Type': 'application/json',
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            raw = response.read(16_384)
            if response.status != 200:
                raise DeviceCheckServiceError(f'Apple HTTP {response.status}')
            if not raw:
                return {}
            result = json.loads(raw.decode('utf-8'))
            if not isinstance(result, dict):
                raise DeviceCheckServiceError('استجابة Apple غير صالحة')
            return result
    except urllib.error.HTTPError as exc:
        # لا نسجل token أو جسم الرد لأنه قد يحمل معلومات تشخيصية حساسة.
        raise DeviceCheckServiceError(f'Apple HTTP {exc.code}') from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise DeviceCheckServiceError('تعذّر الاتصال بخدمة Apple DeviceCheck') from exc

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

# ─── حد معدل محلي/موزع ─────────────────────────────────────────────────────
# الذاكرة تكفي للتطوير المحلي فقط. في production أو Replit Deployment تُحفظ
# النافذة في Firestore وتُحدّث بشرط updateTime، فيرى كل خادم Autoscale العداد
# نفسه. لا نخزن UID أو مفتاح الحد خاماً؛ اسم الوثيقة بصمة أحادية الاتجاه.
_rate_lock = threading.Lock()
_rate_buckets = {}   # key -> list[timestamps]
_rate_limit_failure_log_lock = threading.Lock()
_rate_limit_failure_log_at = 0.0
_DISTRIBUTED_RATE_LIMIT_COLLECTION = 'distributed_rate_limits'
_DISTRIBUTED_RATE_LIMIT_MAX_RETRIES = 8


class DistributedRateLimitUnavailable(RuntimeError):
    """تعذّر اتخاذ قرار حد موزع؛ مسارات الإنتاج تفشل مغلقاً."""


def distributed_rate_limit_ttl_configured() -> bool:
    """هل أكد المشغّل تفعيل TTL على distributed_rate_limits.expire_at؟"""
    return env_flag(
        'FATINAH_DISTRIBUTED_RATE_LIMIT_TTL_CONFIGURED', False)


def distributed_rate_limit_configured() -> bool:
    """هل أكد المشغّل تفعيل Firestore limiter وسياسة TTL الخاصة به؟"""
    return (
        env_flag('FATINAH_DISTRIBUTED_RATE_LIMIT_CONFIGURED', False)
        and distributed_rate_limit_ttl_configured()
    )


def distributed_rate_limit_required() -> bool:
    """Autoscale/production لا يجوز أن يعود إلى عداد داخل عملية واحدة."""
    return (
        deployment_environment() == 'production'
        or IS_REPLIT_DEPLOYMENT
        or distributed_rate_limit_configured()
    )


def _rate_limit_document_path(key: str) -> str:
    normalized = str(key or '').strip()
    if not normalized or len(normalized) > 1024:
        raise ValueError('مفتاح حد المعدل غير صالح')
    digest = hashlib.sha256(
        b'fatinah-distributed-rate-limit-v1\0'
        + normalized.encode('utf-8')
    ).hexdigest()
    return f'{_DISTRIBUTED_RATE_LIMIT_COLLECTION}/{digest}'


def _distributed_rate_limited(key: str, max_calls: int,
                              window_sec: int) -> bool:
    """Sliding window ذرية عبر Firestore مع optimistic compare-and-set.

    كل طلب مقبول يكتب قائمة timestamps صغيرة (أكبر حد حالي 300). إذا تنافست
    نسختان يعيد الخاسر القراءة والمحاولة؛ وعند نفاد المحاولات يرفع خطأً كي
    يفشل الغلاف مغلقاً. expire_at مخصص لسياسة Firestore TTL ولا يدخل القرار.
    """
    if (not isinstance(max_calls, int) or isinstance(max_calls, bool)
            or not 1 <= max_calls <= 10_000
            or not isinstance(window_sec, int) or isinstance(window_sec, bool)
            or not 1 <= window_sec <= 86_400):
        raise ValueError('سياسة حد المعدل غير صالحة')
    if not firestore_durable_available():
        raise DistributedRateLimitUnavailable(
            'بيانات اعتماد Firestore غير متاحة لحد المعدل')

    document_path = _rate_limit_document_path(key)
    window_ms = window_sec * 1000
    for attempt in range(_DISTRIBUTED_RATE_LIMIT_MAX_RETRIES):
        now_ms = int(time.time() * 1000)
        try:
            record = firestore_get_document(document_path)
        except Exception as exc:
            raise DistributedRateLimitUnavailable(
                'تعذّرت قراءة عداد حد المعدل') from exc

        raw_calls = [] if not record else record.get('calls', [])
        if (not isinstance(raw_calls, list) or len(raw_calls) > 10_000
                or any(isinstance(value, bool)
                       or not isinstance(value, (int, float))
                       for value in raw_calls)):
            raise DistributedRateLimitUnavailable(
                'وثيقة حد المعدل غير صالحة')
        recent = []
        for value in raw_calls:
            timestamp = int(value)
            # اختلاف الساعة الصغير بين نسخ managed hosting لا يفتح حصة
            # إضافية: timestamp المستقبلي القريب يُحسب. قفزة أكبر من خمس
            # دقائق تعني ساعة/وثيقة غير موثوقة ونفشل مغلقاً.
            if timestamp < 0 or timestamp > now_ms + 300_000:
                raise DistributedRateLimitUnavailable(
                    'timestamp حد المعدل غير صالح')
            if now_ms - timestamp < window_ms:
                recent.append(timestamp)
        if len(recent) >= max_calls:
            return True

        recent.append(now_ms)
        expiry = datetime.datetime.fromtimestamp(
            (now_ms + (window_ms * 2)) / 1000,
            tz=datetime.timezone.utc,
        )
        updated = {
            'calls': recent,
            'max_calls': max_calls,
            'window_seconds': window_sec,
            'updated_at_ms': now_ms,
            'expire_at': expiry,
        }
        try:
            if record is None:
                if firestore_create_document_if_absent(
                        document_path, updated):
                    return False
            else:
                update_time = str(record.get('_update_time') or '').strip()
                if not update_time:
                    raise DistributedRateLimitUnavailable(
                        'وثيقة حد المعدل بلا updateTime')
                if firestore_set_document_if_update_time(
                        document_path, updated, update_time):
                    return False
        except DistributedRateLimitUnavailable:
            raise
        except Exception as exc:
            raise DistributedRateLimitUnavailable(
                'تعذّر تحديث عداد حد المعدل') from exc

        # تعارض CAS طبيعي تحت الطلب المتزامن. مهلة قصيرة تحد الازدحام من دون
        # إبقاء خيط HTTP معلقاً زمناً ملحوظاً.
        if attempt + 1 < _DISTRIBUTED_RATE_LIMIT_MAX_RETRIES:
            time.sleep(min(0.004 * (attempt + 1), 0.02))

    raise DistributedRateLimitUnavailable(
        'تجاوز حد المعدل عدد محاولات التزامن')


def _local_rate_limited(key: str, max_calls: int, window_sec: int) -> bool:
    now = time.time()
    with _rate_lock:
        bucket = [
            timestamp for timestamp in _rate_buckets.get(key, [])
            if now - timestamp < window_sec
        ]
        if len(bucket) >= max_calls:
            _rate_buckets[key] = bucket
            return True
        bucket.append(now)
        _rate_buckets[key] = bucket
        if len(_rate_buckets) > 10_000:
            for stale_key in [
                    stale_key for stale_key, timestamps in _rate_buckets.items()
                    if not timestamps or now - timestamps[-1] > window_sec]:
                _rate_buckets.pop(stale_key, None)
    return False


def _log_distributed_rate_limit_failure(key: str, exc: BaseException) -> None:
    """سجل تشخيصاً بلا UID وبحد مرة كل دقيقة لتجنب إغراق السجلات."""
    global _rate_limit_failure_log_at
    now = time.monotonic()
    with _rate_limit_failure_log_lock:
        if now - _rate_limit_failure_log_at < 60:
            return
        _rate_limit_failure_log_at = now
    print('[Rate Limit] distributed decision unavailable '
          f'key_ref={safe_log_reference(key)}: {exception_kind(exc)}')


def rate_limited(key: str, max_calls: int, window_sec: int) -> bool:
    """يعيد True عند التجاوز أو عند تعذر الحماية الموزعة المطلوبة.

    الفشل المغلق مقصود: تعطل Firestore أو نسيان العلم في production لا يسمح
    لطلبات الكتابة/التوليد بتجاوز الحماية عبر نسخة Autoscale أخرى.
    """
    if not distributed_rate_limit_required():
        return _local_rate_limited(key, max_calls, window_sec)
    try:
        if not distributed_rate_limit_configured():
            raise DistributedRateLimitUnavailable(
                'حد المعدل الموزع غير مفعّل')
        return _distributed_rate_limited(key, max_calls, window_sec)
    except Exception as exc:
        _log_distributed_rate_limit_failure(key, exc)
        return True

METRIC_EVENTS = {
    'game_started', 'game_completed', 'free_round_completed',
    'paywall_viewed', 'offer_code_opened',
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
        elif key in {'teams', 'categoryCount', 'questions', 'correct',
                     'incorrect', 'durationSeconds', 'topScore'}:
            if not isinstance(value, int) or isinstance(value, bool):
                return False
            minimum, maximum = {
                'teams': (1, 3),
                'categoryCount': (0, 20),
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
    if isinstance(value, datetime.datetime):
        normalized = value
        if normalized.tzinfo is None:
            normalized = normalized.replace(tzinfo=datetime.timezone.utc)
        normalized = normalized.astimezone(datetime.timezone.utc)
        return {
            'timestampValue': normalized.isoformat(
                timespec='microseconds').replace('+00:00', 'Z')
        }
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
    # updateTime ليس من بيانات التطبيق، لكنه شرط مقارنة آمن عند تحرير lease.
    # إبقاؤه باسم داخلي يمنع حذف قفل استحوذت عليه عملية أخرى بعد انتهاء lease.
    result['_update_time'] = document.get('updateTime') or ''
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


def firestore_set_document_if_update_time(document_path: str, data: dict,
                                          update_time: str) -> bool:
    """حدّث وثيقة فقط إذا لم تتغير منذ قراءتها.

    يستخدم App Attest الشرط لمنع طلبين متزامنين من قبول عدّاد assertion
    انطلاقاً من الحالة القديمة نفسها.
    """
    if not update_time:
        return False
    project_id, token = _firestore_credentials()
    fields = {str(key): _firestore_value(value) for key, value in data.items()}
    query_items = [
        ('updateMask.fieldPaths', key) for key in fields
    ] + [('currentDocument.updateTime', update_time)]
    url = _firestore_document_url(project_id, document_path)
    url += '?' + urllib.parse.urlencode(query_items, doseq=True)
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
            response.read()
        return True
    except urllib.error.HTTPError as exc:
        if exc.code in {404, 409, 412} or _firestore_precondition_failed(exc):
            return False
        raise RuntimeError(
            _firestore_http_error(exc, f'conditional set {document_path}')) from exc

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


def firestore_create_document_if_absent(document_path: str, data: dict):
    """أنشئ وثيقة ذرياً، أو أعد None إذا كان الاسم مستخدماً بالفعل.

    createDocument في Firestore يضمن أن نسختين من خادم autoscale لا
    تستحوذان على lease نفسه. تعاد updateTime لاستخدامها كشرط عند التحرير.
    """
    segments = [segment for segment in document_path.strip('/').split('/') if segment]
    if len(segments) < 2 or len(segments) % 2:
        raise ValueError('مسار وثيقة Firestore غير صالح')
    project_id, token = _firestore_credentials()
    parent_segments = segments[:-2]
    collection_id, document_id = segments[-2:]
    base = (
        f'https://firestore.googleapis.com/v1/projects/{project_id}'
        f'/databases/{firestore_database_path()}/documents'
    )
    if parent_segments:
        base += '/' + '/'.join(
            urllib.parse.quote(segment, safe='') for segment in parent_segments)
    url = (
        f'{base}/{urllib.parse.quote(collection_id, safe="")}?'
        + urllib.parse.urlencode({'documentId': document_id})
    )
    fields = {str(key): _firestore_value(value) for key, value in data.items()}
    req = urllib.request.Request(
        url,
        data=json.dumps({'fields': fields}, ensure_ascii=False).encode(),
        method='POST',
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json; charset=utf-8',
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            document = json.loads(response.read())
            update_time = str(document.get('updateTime') or '').strip()
            if not update_time:
                raise RuntimeError('Firestore createDocument بلا updateTime')
            return update_time
    except urllib.error.HTTPError as exc:
        if exc.code == 409:
            return None
        raise RuntimeError(
            _firestore_http_error(exc, f'create {document_path}')) from exc


def firestore_delete_document_if_update_time(document_path: str,
                                             update_time: str) -> bool:
    """احذف وثيقة فقط إن بقيت النسخة ذات updateTime نفسها."""
    if not update_time:
        return False
    project_id, token = _firestore_credentials()
    url = _firestore_document_url(project_id, document_path)
    url += '?' + urllib.parse.urlencode({
        'currentDocument.updateTime': update_time,
    })
    req = urllib.request.Request(
        url, method='DELETE', headers={'Authorization': f'Bearer {token}'})
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            response.read()
        return True
    except urllib.error.HTTPError as exc:
        if exc.code in {404, 409, 412} or _firestore_precondition_failed(exc):
            return False
        raise RuntimeError(
            _firestore_http_error(exc, f'conditional delete {document_path}')) from exc


def acquire_devicecheck_claim_guard():
    """تسلسل query→update محلياً وعبر كل نسخ خادم autoscale.

    DeviceCheck يقدّم عمليتي استعلام وتحديث منفصلتين ولا يعرض معرّف جهاز
    ثابتاً للخادم. لذلك نستخدم lease عالمي قصير في Firestore حول العمليتين؛
    هذا يمنع حسابين متزامنين من رؤية bit0=false معاً. في الإنتاج نفشل
    مغلقاً إذا لم يتوفر المخزن الدائم، بينما تستخدم الاختبارات المحلية
    القفل داخل العملية فقط.
    """
    if not _devicecheck_claim_local_lock.acquire(timeout=5):
        raise DeviceCheckClaimBusyError('مطالبة محلية أخرى قيد التنفيذ')

    handle = {'distributed': False, 'update_time': ''}
    try:
        if not firestore_durable_available():
            if deployment_environment() == 'production' or durable_storage_required():
                raise DeviceCheckConfigurationError(
                    'قفل DeviceCheck الموزع يحتاج Firestore')
            return handle

        owner = str(uuid.uuid4())
        for _ in range(2):
            now = int(time.time())
            update_time = firestore_create_document_if_absent(
                _DEVICECHECK_CLAIM_LOCK_PATH,
                {
                    'owner': owner,
                    'expires_at': now + _DEVICECHECK_CLAIM_LEASE_SECONDS,
                    'purpose': 'devicecheck_free_round_claim',
                },
            )
            if update_time:
                return {
                    'distributed': True,
                    'update_time': update_time,
                }

            existing = firestore_get_document(_DEVICECHECK_CLAIM_LOCK_PATH)
            if not existing:
                continue
            try:
                expires_at = int(existing.get('expires_at') or 0)
            except (TypeError, ValueError):
                expires_at = 0
            existing_update_time = str(existing.get('_update_time') or '').strip()
            if expires_at > now or not existing_update_time:
                raise DeviceCheckClaimBusyError('مطالبة موزعة أخرى قيد التنفيذ')
            if not firestore_delete_document_if_update_time(
                    _DEVICECHECK_CLAIM_LOCK_PATH, existing_update_time):
                raise DeviceCheckClaimBusyError('تغير مالك المطالبة الموزعة')

        raise DeviceCheckClaimBusyError('تعذّر الاستحواذ على المطالبة الموزعة')
    except (DeviceCheckClaimBusyError, DeviceCheckConfigurationError):
        _devicecheck_claim_local_lock.release()
        raise
    except Exception as exc:
        _devicecheck_claim_local_lock.release()
        raise DeviceCheckServiceError(
            'تعذّر إنشاء قفل DeviceCheck الموزع') from exc


def release_devicecheck_claim_guard(handle) -> None:
    """حرر lease الذي نملكه فقط؛ عند تعذر الحذف تنتهي صلاحيته تلقائياً."""
    try:
        if handle and handle.get('distributed'):
            try:
                firestore_delete_document_if_update_time(
                    _DEVICECHECK_CLAIM_LOCK_PATH,
                    str(handle.get('update_time') or ''),
                )
            except Exception as exc:
                # لا نُفشل مطالبة ثُبتت لدى Apple؛ lease القصير يتعافى ذاتياً.
                print(f'[DeviceCheck] distributed lock release failed: {type(exc).__name__}')
    finally:
        if _devicecheck_claim_local_lock.locked():
            _devicecheck_claim_local_lock.release()

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
    if op not in {
        'EQUAL', 'ARRAY_CONTAINS', 'LESS_THAN', 'LESS_THAN_OR_EQUAL',
    }:
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


def firestore_batch_delete_documents(document_paths):
    """احذف وثائق معلومة في طلب واحد؛ لا يعمل شيئاً للقائمة الفارغة."""
    paths = [str(path).strip('/') for path in document_paths if str(path).strip('/')]
    if not paths:
        return
    if len(paths) > 500:
        raise ValueError('دفعة حذف Firestore تتجاوز 500 وثيقة')
    project_id, token = _firestore_credentials()
    writes = [{
        'delete': (
            f'projects/{project_id}/databases/{firestore_database_name()}'
            f'/documents/{path}'
        )
    } for path in paths]
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
        raise RuntimeError(_firestore_http_error(exc, 'batch delete')) from exc


def durable_write(document_path: str, data: dict, *, merge: bool = True) -> bool:
    """اكتب إلى المخزن الدائم أو ارفع خطأ في النشر ذي التخزين الإلزامي."""
    if firestore_durable_available():
        firestore_set_document(document_path, data, merge=merge)
        return True
    if durable_storage_required():
        raise RuntimeError('التخزين الدائم مطلوب لكن بيانات اعتماد Firestore غير مكتملة')
    return False


class QuestionPlatformStorageError(RuntimeError):
    pass


class QuestionPlatformBusyError(RuntimeError):
    pass


def _question_platform_lock(uid: str):
    digest = hashlib.sha256(str(uid).encode('utf-8')).digest()
    return _question_platform_local_locks[
        int.from_bytes(digest[:2], 'big') % len(_question_platform_local_locks)]


def acquire_question_platform_guard(uid: str):
    """Serialize pack allocation for one account across all server replicas."""
    local_lock = _question_platform_lock(uid)
    if not local_lock.acquire(timeout=5):
        raise QuestionPlatformBusyError('طلب جولة آخر قيد التجهيز')
    handle = {'local_lock': local_lock, 'distributed': False,
              'path': '', 'update_time': ''}
    try:
        if not firestore_durable_available():
            if deployment_environment() == 'production' or durable_storage_required():
                raise QuestionPlatformStorageError('قفل الجولات الموزع غير مهيأ')
            return handle
        digest = hashlib.sha256(str(uid).encode('utf-8')).hexdigest()
        path = f'question_platform_locks/{digest}'
        owner = str(uuid.uuid4())
        for _ in range(2):
            now = int(time.time())
            update_time = firestore_create_document_if_absent(path, {
                'owner': owner, 'expires_at': now + _QUESTION_PLATFORM_LEASE_SECONDS,
                'purpose': 'game_pack_allocation',
            })
            if update_time:
                handle.update(distributed=True, path=path, update_time=update_time)
                return handle
            existing = firestore_get_document(path)
            if not existing:
                continue
            existing_update = str(existing.get('_update_time') or '')
            if int(existing.get('expires_at') or 0) > now or not existing_update:
                raise QuestionPlatformBusyError('جهاز آخر يجهز الجولة')
            if not firestore_delete_document_if_update_time(path, existing_update):
                raise QuestionPlatformBusyError('تغير مالك قفل الجولة')
        raise QuestionPlatformBusyError('تعذر حجز الجولة')
    except Exception:
        local_lock.release()
        raise


def release_question_platform_guard(handle) -> None:
    try:
        if handle and handle.get('distributed'):
            try:
                firestore_delete_document_if_update_time(
                    str(handle.get('path') or ''),
                    str(handle.get('update_time') or ''))
            except Exception as exc:
                print('[Question Platform] lock release failed: '
                      f'{exception_kind(exc)}')
    finally:
        local_lock = handle.get('local_lock') if handle else None
        if local_lock and local_lock.locked():
            local_lock.release()


def sync_question_platform_questions() -> None:
    if firestore_durable_available():
        try:
            documents = firestore_list_documents('question_platform_questions')
            question_platform.cache_questions(DB_PATH, documents)
            return
        except Exception as exc:
            if deployment_environment() == 'production' or durable_storage_required():
                raise QuestionPlatformStorageError(
                    'تعذرت قراءة بنك الأسئلة الدائم') from exc
    if deployment_environment() == 'production' or durable_storage_required():
        raise QuestionPlatformStorageError('التخزين الدائم للأسئلة غير مهيأ')


def sync_question_platform_user(uid: str) -> None:
    if firestore_durable_available():
        try:
            question_platform.cache_user_state(
                DB_PATH, uid,
                packs=firestore_list_documents(f'users/{uid}/game_packs'),
                seen=firestore_list_documents(f'users/{uid}/question_platform_seen'),
                cycles=firestore_list_documents(f'users/{uid}/question_platform_cycles'),
            )
            return
        except Exception as exc:
            if deployment_environment() == 'production' or durable_storage_required():
                raise QuestionPlatformStorageError(
                    'تعذرت قراءة سجل الجولات الدائم') from exc
    if deployment_environment() == 'production' or durable_storage_required():
        raise QuestionPlatformStorageError('سجل الجولات الدائم غير مهيأ')


def persist_question_platform_user(uid: str) -> None:
    snapshot = question_platform.user_state_snapshot(DB_PATH, uid)
    if not firestore_durable_available():
        if deployment_environment() == 'production' or durable_storage_required():
            raise QuestionPlatformStorageError('تعذر حفظ سجل الجولات بشكل دائم')
        return
    records = []
    records.extend((f'users/{uid}/game_packs/{item["packId"]}', item)
                   for item in snapshot['packs'])
    records.extend((f'users/{uid}/question_platform_seen/{item["questionId"]}', item)
                   for item in snapshot['seen'])
    records.extend((f'users/{uid}/question_platform_cycles/{item["level"]}', item)
                   for item in snapshot['cycles'])
    try:
        for offset in range(0, len(records), 400):
            firestore_batch_set_documents(records[offset:offset + 400])
    except Exception as exc:
        raise QuestionPlatformStorageError('تعذر حفظ سجل الجولات الدائم') from exc


def persist_question_platform_question(question: dict) -> None:
    question_id = str(question.get('questionId') or '')
    if not question_id:
        raise QuestionPlatformStorageError('معرف السؤال مفقود')
    try:
        durable_write(f'question_platform_questions/{question_id}', question,
                      merge=False)
    except Exception as exc:
        raise QuestionPlatformStorageError('تعذر حفظ السؤال بشكل دائم') from exc


def persist_question_platform_metrics(question_ids) -> None:
    if not firestore_durable_available():
        if deployment_environment() == 'production' or durable_storage_required():
            raise QuestionPlatformStorageError('مخزن مؤشرات الأسئلة غير مهيأ')
        return
    records = []
    for question_id in list(dict.fromkeys(str(item) for item in question_ids))[:200]:
        try:
            question = question_platform.question_by_id(DB_PATH, question_id)
        except question_platform.NotFoundError:
            continue
        records.append((f'question_platform_questions/{question_id}', question))
    try:
        if records:
            firestore_batch_set_documents(records)
    except Exception as exc:
        raise QuestionPlatformStorageError('تعذر حفظ مؤشرات الأسئلة') from exc


def persist_question_platform_report(report: dict) -> None:
    report_id = str(report.get('report_id') or report.get('reportId') or '')
    if not report_id:
        return
    try:
        durable_write(f'question_platform_reports/{report_id}', report, merge=False)
    except Exception as exc:
        if deployment_environment() == 'production' or durable_storage_required():
            raise QuestionPlatformStorageError('تعذر حفظ البلاغ بشكل دائم') from exc


def sync_question_platform_reports() -> None:
    if firestore_durable_available():
        try:
            question_platform.cache_reports(
                DB_PATH, firestore_list_documents('question_platform_reports'))
            return
        except Exception as exc:
            if deployment_environment() == 'production' or durable_storage_required():
                raise QuestionPlatformStorageError('تعذرت قراءة البلاغات') from exc
    if deployment_environment() == 'production' or durable_storage_required():
        raise QuestionPlatformStorageError('مخزن البلاغات غير مهيأ')


def ios_diagnostic_retention_fields(now=None) -> dict:
    """حقول زمنية موحّدة لـSQLite/Firestore دون هوية مستخدم."""
    created = now or datetime.datetime.now(datetime.timezone.utc)
    if created.tzinfo is None:
        created = created.replace(tzinfo=datetime.timezone.utc)
    created = created.astimezone(datetime.timezone.utc)
    expires = created + datetime.timedelta(days=IOS_DIAGNOSTIC_RETENTION_DAYS)
    return {
        'created_at': created.isoformat(
            timespec='seconds').replace('+00:00', 'Z'),
        'expire_at': expires,
    }


def persist_free_round_completion(uid: str) -> None:
    """ثبّت إكمال الجولة التعريفية مرة واحدة."""
    completed_at = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    durable_write(f'free_rounds/{uid}', {
        'uid': uid,
        'completed': True,
        'completed_at': completed_at,
    })
    conn = db_connect()
    try:
        conn.execute('''
            INSERT INTO free_rounds (uid, completed_at)
            VALUES (?, ?)
            ON CONFLICT(uid) DO UPDATE SET
                completed_at=excluded.completed_at
        ''', (uid, completed_at))
        conn.commit()
    finally:
        conn.close()


# ─── App Attest: تحديات قصيرة ومفاتيح تثبيت موثقة ──────────────────────────
APP_ATTEST_CHALLENGE_TTL_SECONDS = 300
APP_ATTEST_PURPOSES = {
    'attest', 'free_round_status', 'free_round_complete',
}


class AppAttestValidationError(RuntimeError):
    """بيانات App Attest مفقودة أو مرفوضة أو معاد تشغيلها."""


class AppAttestStorageError(RuntimeError):
    """تعذر الوصول إلى الحالة الدائمة اللازمة لقرار App Attest."""


def _app_attest_key_material(key_id: str) -> tuple[str, bytes]:
    value = str(key_id or '').strip()
    if not value or len(value) > 128 or '\n' in value or '\r' in value:
        raise AppAttestValidationError('معرّف App Attest غير صالح')
    try:
        decoded = base64.b64decode(value, validate=True)
    except Exception as exc:
        raise AppAttestValidationError('معرّف App Attest غير صالح') from exc
    if len(decoded) != 32 or base64.b64encode(decoded).decode('ascii') != value:
        raise AppAttestValidationError('معرّف App Attest غير قياسي')
    return hashlib.sha256(decoded).hexdigest(), decoded


def _app_attest_request_hash(value: str = '') -> str:
    normalized = str(value or '').strip().lower()
    if normalized and not re.fullmatch(r'[0-9a-f]{64}', normalized):
        raise AppAttestValidationError('بصمة الطلب غير صالحة')
    return normalized


def _app_attest_uid_hash(uid: str) -> str:
    """بصمة حساب خاصة بسياق App Attest؛ لا نخزن UID الخام في التحديات."""
    value = str(uid or '').strip()
    if not value or len(value) > 256:
        raise AppAttestValidationError('هوية حساب App Attest غير صالحة')
    return hashlib.sha256(
        b'fatinah-app-attest-uid-v1\0' + value.encode('utf-8')
    ).hexdigest()


def _app_attest_client_data(*, challenge_id: str, challenge: bytes,
                            uid_hash: str,
                            key_id_hash: str, purpose: str,
                            request_hash: str) -> bytes:
    # JSON canonical ثابت بين JavaScript والخادم. لا يحتوي token أو نصاً
    # شخصياً؛ بصمة uid تربط assertion بالحساب من دون تخزين المعرّف الخام.
    return json.dumps({
        'challenge': base64.b64encode(challenge).decode('ascii'),
        'challengeId': challenge_id,
        'keyIdHash': key_id_hash,
        'purpose': purpose,
        'requestHash': request_hash,
        'uidHash': uid_hash,
    }, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def create_app_attest_challenge(uid: str, key_id: str, purpose: str,
                                request_hash: str = '') -> dict:
    if purpose not in APP_ATTEST_PURPOSES:
        raise AppAttestValidationError('غرض App Attest غير صالح')
    key_id_hash, _ = _app_attest_key_material(key_id)
    uid_hash = _app_attest_uid_hash(uid)
    request_hash = _app_attest_request_hash(request_hash)
    challenge = secrets.token_bytes(32)
    expires_at = int(time.time()) + APP_ATTEST_CHALLENGE_TTL_SECONDS

    for _ in range(3):
        challenge_id = secrets.token_urlsafe(24)
        client_data = _app_attest_client_data(
            challenge_id=challenge_id,
            challenge=challenge,
            uid_hash=uid_hash,
            key_id_hash=key_id_hash,
            purpose=purpose,
            request_hash=request_hash,
        )
        record = {
            'uid_hash': uid_hash,
            'key_id_hash': key_id_hash,
            'purpose': purpose,
            'client_data': base64.b64encode(client_data).decode('ascii'),
            'request_hash': request_hash,
            'expires_at': expires_at,
            # حقل Timestamp مستقل لتفعيل Firestore TTL على المجموعة. يبقى
            # expires_at الرقمي للتحقق المتزامن الدقيق قبل قبول assertion.
            'expire_at': datetime.datetime.fromtimestamp(
                expires_at, tz=datetime.timezone.utc),
        }
        if firestore_durable_available():
            try:
                if firestore_create_document_if_absent(
                        f'app_attest_challenges/{challenge_id}', record):
                    break
            except Exception as exc:
                raise AppAttestStorageError(
                    'تعذّر حفظ تحدي App Attest') from exc
        elif deployment_environment() == 'production' or durable_storage_required():
            raise AppAttestStorageError(
                'تحديات App Attest تحتاج Firestore')
        else:
            conn = db_connect()
            try:
                conn.execute('DELETE FROM app_attest_challenges WHERE expires_at < ?',
                             (int(time.time()) - 60,))
                conn.execute('''
                    INSERT INTO app_attest_challenges
                    (challenge_id, uid_hash, key_id_hash, purpose, client_data,
                     request_hash, expires_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                ''', (
                    challenge_id, uid_hash, key_id_hash, purpose,
                    record['client_data'], request_hash, expires_at,
                ))
                conn.commit()
                break
            except sqlite3.IntegrityError:
                continue
            finally:
                conn.close()
    else:
        raise AppAttestStorageError('تعذّر إنشاء تحدي App Attest فريد')

    return {
        'challengeId': challenge_id,
        'clientData': record['client_data'],
        'expiresIn': APP_ATTEST_CHALLENGE_TTL_SECONDS,
    }


def get_app_attest_challenge(challenge_id: str, *, uid: str, key_id: str,
                             purpose: str, request_hash: str = '') -> dict:
    if not re.fullmatch(r'[A-Za-z0-9_-]{24,64}', str(challenge_id or '')):
        raise AppAttestValidationError('معرّف التحدي غير صالح')
    key_id_hash, _ = _app_attest_key_material(key_id)
    uid_hash = _app_attest_uid_hash(uid)
    request_hash = _app_attest_request_hash(request_hash)
    if firestore_durable_available():
        try:
            record = firestore_get_document(
                f'app_attest_challenges/{challenge_id}')
        except Exception as exc:
            raise AppAttestStorageError('تعذّر قراءة تحدي App Attest') from exc
    elif deployment_environment() == 'production' or durable_storage_required():
        raise AppAttestStorageError('تحديات App Attest تحتاج Firestore')
    else:
        conn = db_connect()
        try:
            row = conn.execute('''
                SELECT uid_hash, key_id_hash, purpose, client_data, request_hash,
                       expires_at, consumed_at
                FROM app_attest_challenges WHERE challenge_id=?
            ''', (challenge_id,)).fetchone()
        finally:
            conn.close()
        record = None if not row else {
            'uid_hash': row[0], 'key_id_hash': row[1], 'purpose': row[2],
            'client_data': row[3], 'request_hash': row[4],
            'expires_at': row[5], 'consumed_at': row[6],
        }
    if not record or record.get('consumed_at'):
        raise AppAttestValidationError('تحدي App Attest غير موجود أو مستخدم')
    if int(record.get('expires_at') or 0) < int(time.time()):
        raise AppAttestValidationError('انتهت صلاحية تحدي App Attest')
    stored_uid_hash = str(record.get('uid_hash') or '')
    if (not secrets.compare_digest(stored_uid_hash, uid_hash)
            or record.get('key_id_hash') != key_id_hash
            or record.get('purpose') != purpose
            or str(record.get('request_hash') or '') != request_hash):
        raise AppAttestValidationError('سياق تحدي App Attest لا يطابق الطلب')
    record['challenge_id'] = challenge_id
    return record


def consume_app_attest_challenge(record: dict) -> None:
    challenge_id = str(record.get('challenge_id') or '')
    if firestore_durable_available():
        update_time = str(record.get('_update_time') or '')
        try:
            consumed = firestore_delete_document_if_update_time(
                f'app_attest_challenges/{challenge_id}', update_time)
        except Exception as exc:
            raise AppAttestStorageError(
                'تعذّر استهلاك تحدي App Attest') from exc
        if not consumed:
            raise AppAttestValidationError('استُخدم تحدي App Attest بالتزامن')
        return
    conn = db_connect()
    try:
        changed = conn.execute('''
            UPDATE app_attest_challenges SET consumed_at=?
            WHERE challenge_id=? AND consumed_at IS NULL
        ''', (int(time.time()), challenge_id)).rowcount
        conn.commit()
    finally:
        conn.close()
    if changed != 1:
        raise AppAttestValidationError('استُخدم تحدي App Attest بالتزامن')


def get_app_attest_key(key_id: str):
    key_id_hash, _ = _app_attest_key_material(key_id)
    if firestore_durable_available():
        try:
            return firestore_get_document(f'app_attest_keys/{key_id_hash}')
        except Exception as exc:
            raise AppAttestStorageError('تعذّرت قراءة مفتاح App Attest') from exc
    if deployment_environment() == 'production' or durable_storage_required():
        raise AppAttestStorageError('مفاتيح App Attest تحتاج Firestore')
    conn = db_connect()
    try:
        row = conn.execute('''
            SELECT key_id, public_key_pem, receipt, counter, environment,
                   attested_at FROM app_attest_keys WHERE key_id_hash=?
        ''', (key_id_hash,)).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    return {
        'key_id': row[0], 'public_key_pem': row[1], 'receipt': row[2],
        'counter': row[3], 'environment': row[4], 'attested_at': row[5],
        '_local': True,
    }


def store_app_attest_key(key_id: str, result, environment: str) -> None:
    key_id_hash, _ = _app_attest_key_material(key_id)
    record = {
        'key_id': key_id,
        'public_key_pem': result.public_key_pem.decode('ascii'),
        'receipt': base64.b64encode(result.receipt).decode('ascii'),
        'counter': 0,
        'environment': environment,
        'attested_at': int(time.time()),
    }
    if firestore_durable_available():
        try:
            created = firestore_create_document_if_absent(
                f'app_attest_keys/{key_id_hash}', record)
            if created:
                return
            existing = firestore_get_document(f'app_attest_keys/{key_id_hash}')
            if existing and existing.get('key_id') == key_id:
                return
            raise AppAttestValidationError(
                'مفتاح App Attest مرتبط بسجل آخر')
        except AppAttestValidationError:
            raise
        except Exception as exc:
            raise AppAttestStorageError('تعذّر حفظ مفتاح App Attest') from exc
    if deployment_environment() == 'production' or durable_storage_required():
        raise AppAttestStorageError('مفاتيح App Attest تحتاج Firestore')
    conn = db_connect()
    try:
        conn.execute('''
            INSERT INTO app_attest_keys
            (key_id_hash, key_id, public_key_pem, receipt, counter,
             environment, attested_at)
            VALUES (?, ?, ?, ?, 0, ?, ?)
            ON CONFLICT(key_id_hash) DO NOTHING
        ''', (
            key_id_hash, key_id, record['public_key_pem'], record['receipt'],
            environment, record['attested_at'],
        ))
        conn.commit()
    finally:
        conn.close()


def update_app_attest_counter(key_id: str, key_record: dict,
                              new_counter: int) -> None:
    key_id_hash, _ = _app_attest_key_material(key_id)
    if firestore_durable_available():
        try:
            changed = firestore_set_document_if_update_time(
                f'app_attest_keys/{key_id_hash}',
                {'counter': int(new_counter)},
                str(key_record.get('_update_time') or ''),
            )
        except Exception as exc:
            raise AppAttestStorageError(
                'تعذّر تحديث عداد App Attest') from exc
        if not changed:
            raise AppAttestValidationError(
                'تغير عداد App Attest بالتزامن؛ أعد المحاولة بتحدٍ جديد')
        return
    conn = db_connect()
    try:
        conn.execute('BEGIN IMMEDIATE')
        changed = conn.execute('''
            UPDATE app_attest_keys SET counter=?
            WHERE key_id_hash=? AND counter=?
        ''', (int(new_counter), key_id_hash,
              int(key_record.get('counter') or 0))).rowcount
        conn.commit()
    finally:
        conn.close()
    if changed != 1:
        raise AppAttestValidationError(
            'تغير عداد App Attest بالتزامن؛ أعد المحاولة بتحدٍ جديد')


def _app_attest_claim_owner_hash(uid: str, key_id_hash: str) -> str:
    """بصمة مالك خاصة بالتثبيت؛ لا تخزن UID خاماً ولا تربط أجهزة مختلفة."""
    value = str(uid or '').strip()
    if not value or len(value) > 256:
        raise AppAttestValidationError('هوية مالك مطالبة التثبيت غير صالحة')
    return hashlib.sha256(
        b'fatinah-free-round-owner-v1\0'
        + key_id_hash.encode('ascii') + b'\0' + value.encode('utf-8')
    ).hexdigest()


def _normalize_app_attest_installation_claim(record):
    if not record:
        return None
    owner_hash = str(record.get('owner_hash') or '').strip().lower()
    state = str(record.get('state') or '').strip().lower()
    # وثائق النسخة التجريبية القديمة كانت تحتوي completed_at فقط. نتعامل
    # معها كمطالبة مكتملة مجهولة المالك: تُحظر إعادة المطالبة ولا تُنسب لأحد.
    if not state and record.get('completed_at') is not None:
        state = 'completed'
    if state not in {'pending', 'completed'}:
        raise AppAttestStorageError('حالة مطالبة التثبيت تالفة')
    if owner_hash and not re.fullmatch(r'[0-9a-f]{64}', owner_hash):
        raise AppAttestStorageError('مالك مطالبة التثبيت تالف')
    normalized = dict(record)
    normalized['owner_hash'] = owner_hash
    normalized['state'] = state
    return normalized


def app_attest_installation_claim(key_id: str):
    key_id_hash, _ = _app_attest_key_material(key_id)
    if firestore_durable_available():
        try:
            return _normalize_app_attest_installation_claim(
                firestore_get_document(
                    f'free_round_installations/{key_id_hash}'))
        except Exception as exc:
            if isinstance(exc, AppAttestStorageError):
                raise
            raise AppAttestStorageError(
                'تعذّرت قراءة مطالبة التثبيت') from exc
    if deployment_environment() == 'production' or durable_storage_required():
        raise AppAttestStorageError('مطالبات التثبيت تحتاج Firestore')
    conn = db_connect()
    try:
        row = conn.execute('''
            SELECT owner_hash, state, created_at, updated_at, completed_at
            FROM free_round_installations
            WHERE key_id_hash=?
        ''', (key_id_hash,)).fetchone()
    finally:
        conn.close()
    return _normalize_app_attest_installation_claim(None if not row else {
        'owner_hash': row[0], 'state': row[1], 'created_at': row[2],
        'updated_at': row[3], 'completed_at': row[4], '_local': True,
    })


def app_attest_installation_claim_access(key_id: str, uid: str,
                                         record=None) -> str:
    """أعد missing/owned_pending/owned_completed/conflict دون كشف المالك."""
    key_id_hash, _ = _app_attest_key_material(key_id)
    claim = (_normalize_app_attest_installation_claim(record)
             if record is not None else app_attest_installation_claim(key_id))
    if not claim:
        return 'missing'
    expected_owner = _app_attest_claim_owner_hash(uid, key_id_hash)
    stored_owner = str(claim.get('owner_hash') or '')
    if (not stored_owner
            or not secrets.compare_digest(stored_owner, expected_owner)):
        return 'conflict'
    return f"owned_{claim['state']}"


def reserve_app_attest_installation_claim(key_id: str, uid: str) -> str:
    """احجز التثبيت ذرياً قبل تغيير DeviceCheck لدى Apple.

    created_pending تعني أن هذا الطلب أنشأ الحجز. owned_pending تعني محاولة
    استرداد للحساب نفسه. أي سجل لمالك مختلف يبقى conflict بلا استبدال.
    """
    key_id_hash, _ = _app_attest_key_material(key_id)
    owner_hash = _app_attest_claim_owner_hash(uid, key_id_hash)
    now = int(time.time())
    record = {
        'owner_hash': owner_hash,
        'state': 'pending',
        'created_at': now,
        'updated_at': now,
    }
    if firestore_durable_available():
        try:
            path = f'free_round_installations/{key_id_hash}'
            created_update_time = firestore_create_document_if_absent(
                path, record)
            if created_update_time:
                return 'created_pending'
            existing = firestore_get_document(path)
            if not existing:
                raise RuntimeError(
                    'اختفت مطالبة التثبيت بعد تعارض الإنشاء')
            return app_attest_installation_claim_access(
                key_id, uid, existing)
        except Exception as exc:
            if isinstance(exc, (AppAttestStorageError,
                                AppAttestValidationError)):
                raise
            raise AppAttestStorageError(
                'تعذّر حجز مطالبة التثبيت') from exc
    if deployment_environment() == 'production' or durable_storage_required():
        raise AppAttestStorageError('مطالبات التثبيت تحتاج Firestore')
    conn = db_connect()
    try:
        conn.execute('BEGIN IMMEDIATE')
        created = conn.execute('''
            INSERT OR IGNORE INTO free_round_installations
            (key_id_hash, owner_hash, state, created_at, updated_at,
             completed_at)
            VALUES (?, ?, 'pending', ?, ?, NULL)
        ''', (key_id_hash, owner_hash, now, now)).rowcount == 1
        row = conn.execute('''
            SELECT owner_hash, state, created_at, updated_at, completed_at
            FROM free_round_installations WHERE key_id_hash=?
        ''', (key_id_hash,)).fetchone()
        conn.commit()
    finally:
        conn.close()
    if not row:
        raise AppAttestStorageError('تعذّر قراءة مطالبة التثبيت المحجوزة')
    access = app_attest_installation_claim_access(key_id, uid, {
        'owner_hash': row[0], 'state': row[1], 'created_at': row[2],
        'updated_at': row[3], 'completed_at': row[4], '_local': True,
    })
    return 'created_pending' if created and access == 'owned_pending' else access


def complete_app_attest_installation_claim(key_id: str, uid: str) -> None:
    """حوّل pending إلى completed بشرط بقاء المالك نفسه."""
    key_id_hash, _ = _app_attest_key_material(key_id)
    owner_hash = _app_attest_claim_owner_hash(uid, key_id_hash)
    now = int(time.time())
    if firestore_durable_available():
        path = f'free_round_installations/{key_id_hash}'
        for _ in range(2):
            try:
                claim = _normalize_app_attest_installation_claim(
                    firestore_get_document(path))
                access = app_attest_installation_claim_access(
                    key_id, uid, claim)
                if access == 'owned_completed':
                    return
                if access != 'owned_pending':
                    raise AppAttestValidationError(
                        'مطالبة التثبيت ليست مملوكة لهذا الحساب')
                changed = firestore_set_document_if_update_time(
                    path,
                    {
                        'state': 'completed',
                        'updated_at': now,
                        'completed_at': now,
                    },
                    str(claim.get('_update_time') or ''),
                )
                if changed:
                    return
            except (AppAttestValidationError, AppAttestStorageError):
                raise
            except Exception as exc:
                raise AppAttestStorageError(
                    'تعذّر إكمال مطالبة التثبيت') from exc
        try:
            claim = _normalize_app_attest_installation_claim(
                firestore_get_document(path))
        except Exception as exc:
            raise AppAttestStorageError(
                'تعذّر التحقق من اكتمال مطالبة التثبيت') from exc
        if app_attest_installation_claim_access(
                key_id, uid, claim) == 'owned_completed':
            return
        raise AppAttestStorageError(
            'تغيرت مطالبة التثبيت بالتزامن قبل اكتمالها')
    if deployment_environment() == 'production' or durable_storage_required():
        raise AppAttestStorageError('مطالبات التثبيت تحتاج Firestore')
    conn = db_connect()
    try:
        conn.execute('BEGIN IMMEDIATE')
        changed = conn.execute('''
            UPDATE free_round_installations
            SET state='completed', updated_at=?, completed_at=?
            WHERE key_id_hash=? AND owner_hash=? AND state='pending'
        ''', (now, now, key_id_hash, owner_hash)).rowcount
        row = conn.execute('''
            SELECT owner_hash, state, created_at, updated_at, completed_at
            FROM free_round_installations WHERE key_id_hash=?
        ''', (key_id_hash,)).fetchone()
        conn.commit()
    finally:
        conn.close()
    if changed == 1:
        return
    access = app_attest_installation_claim_access(key_id, uid, None if not row else {
        'owner_hash': row[0], 'state': row[1], 'created_at': row[2],
        'updated_at': row[3], 'completed_at': row[4], '_local': True,
    })
    if access != 'owned_completed':
        raise AppAttestValidationError(
            'مطالبة التثبيت ليست مملوكة لهذا الحساب')


def _decode_app_attest_artifact(value: str, *, maximum: int) -> bytes:
    encoded = str(value or '').strip()
    if not encoded or len(encoded) > (maximum * 2):
        raise AppAttestValidationError('بيانات App Attest مفقودة أو كبيرة')
    try:
        decoded = base64.b64decode(encoded, validate=True)
    except Exception as exc:
        raise AppAttestValidationError('بيانات App Attest ليست Base64') from exc
    if not decoded or len(decoded) > maximum:
        raise AppAttestValidationError('حجم بيانات App Attest غير صالح')
    return decoded


def free_round_app_attest_request_hash(uid: str, device_token: str,
                                       update_token: str = '') -> str:
    canonical = json.dumps({
        'deviceCheckTokenHash': hashlib.sha256(
            str(device_token or '').encode('utf-8')).hexdigest(),
        'deviceCheckUpdateTokenHash': (
            hashlib.sha256(str(update_token).encode('utf-8')).hexdigest()
            if update_token else ''
        ),
        'uid': str(uid or ''),
    }, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest()


def verify_app_attest_attestation(*, uid: str, key_id: str,
                                  challenge_id: str,
                                  attestation_object: str) -> None:
    challenge = get_app_attest_challenge(
        challenge_id, uid=uid, key_id=key_id, purpose='attest')
    client_data = _decode_app_attest_artifact(
        str(challenge.get('client_data') or ''), maximum=65_536)
    artifact = _decode_app_attest_artifact(
        attestation_object, maximum=2 * 1024 * 1024)
    team_id, bundle_id, environment = app_attest_identity()
    try:
        from app_attest import AppAttestVerificationError, verify_attestation
    except ImportError as exc:
        raise AppAttestStorageError(
            'مكوّن التحقق من App Attest غير متاح') from exc
    try:
        result = verify_attestation(
            artifact,
            key_id=key_id,
            challenge=client_data,
            team_id=team_id,
            bundle_id=bundle_id,
            environment=environment,
        )
    except AppAttestVerificationError as exc:
        raise AppAttestValidationError(exc.code) from exc
    # نحفظ المفتاح أولاً؛ إن ضاعت الاستجابة بعد ذلك يستطيع endpoint الحالة
    # تأكيد التسجيل من دون استدعاء attestKey مرة ثانية.
    store_app_attest_key(key_id, result, environment)
    consume_app_attest_challenge(challenge)


def verify_app_attest_assertion(*, uid: str, key_id: str,
                                challenge_id: str, assertion: str,
                                purpose: str, request_hash: str = '') -> None:
    challenge = get_app_attest_challenge(
        challenge_id, uid=uid, key_id=key_id, purpose=purpose,
        request_hash=request_hash)
    key_record = get_app_attest_key(key_id)
    if not key_record or key_record.get('key_id') != key_id:
        raise AppAttestValidationError('مفتاح App Attest غير مسجّل')
    _, _, environment = app_attest_identity()
    if key_record.get('environment') != environment:
        raise AppAttestValidationError('بيئة مفتاح App Attest لا تطابق الخادم')
    client_data = _decode_app_attest_artifact(
        str(challenge.get('client_data') or ''), maximum=65_536)
    artifact = _decode_app_attest_artifact(assertion, maximum=65_536)
    try:
        public_key_pem = str(
            key_record.get('public_key_pem') or '').encode('ascii')
    except UnicodeEncodeError as exc:
        raise AppAttestValidationError(
            'سجل مفتاح App Attest غير صالح') from exc
    team_id, bundle_id, _ = app_attest_identity()
    try:
        from app_attest import AppAttestVerificationError, verify_assertion
    except ImportError as exc:
        raise AppAttestStorageError(
            'مكوّن التحقق من App Attest غير متاح') from exc
    try:
        result = verify_assertion(
            artifact,
            client_data=client_data,
            public_key_pem=public_key_pem,
            team_id=team_id,
            bundle_id=bundle_id,
            previous_counter=int(key_record.get('counter') or 0),
        )
    except AppAttestVerificationError as exc:
        raise AppAttestValidationError(exc.code) from exc
    except (UnicodeEncodeError, ValueError) as exc:
        raise AppAttestValidationError('سجل مفتاح App Attest غير صالح') from exc
    # عداد المفتاح هو حاجز إعادة التشغيل الذري. نحذّف التحدي بعده؛ إذا تعذر
    # الحذف فإعادة نفس assertion تظل مرفوضة لأن العداد لم يعد أكبر.
    update_app_attest_counter(key_id, key_record, result.counter)
    consume_app_attest_challenge(challenge)

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
        print(f'[Firestore] خطأ: {exception_kind(exc)}')
        return False

def firestore_delete_subscription(uid: str) -> None:
    """احذف كل وثائق Firestore المرتبطة بالحساب أو ارفض نجاح العملية."""
    if not firestore_durable_available():
        raise RuntimeError('بيانات اعتماد Firestore غير مكتملة')

    reverse_identity = firestore_get_document(f'revenuecat_users/{uid}')
    rc_app_user_ids = set()
    reverse_rc_app_user_id = (reverse_identity or {}).get('rc_app_user_id')
    if reverse_rc_app_user_id:
        rc_app_user_ids.add(reverse_rc_app_user_id)
    # v1.2 could create more than one RevenueCat alias for the same Firebase
    # account. Deletion must remove every server-proven alias, not only the
    # canonical reverse document used by v2.
    for identity in firestore_query_documents(
            'revenuecat_identities', 'uid', uid):
        identity_id = str(
            identity.get('rc_app_user_id')
            or identity.get('_document_id') or '').strip().lower()
        if is_valid_rc_app_user_id(identity_id):
            rc_app_user_ids.add(identity_id)

    # Firestore لا يحذف المجموعات الفرعية عند حذف الوثيقة الأب؛ لذلك نحذفها
    # صراحةً قبل وثائق المستوى الأعلى.
    for subcollection in (
            'question_seen', 'question_platform_seen', 'question_platform_cycles',
            'game_packs', 'game_events', 'ios_diagnostics'):
        for document in firestore_list_documents(f'users/{uid}/{subcollection}'):
            firestore_delete_document(
                f'users/{uid}/{subcollection}/{document["_document_id"]}')

    for report in firestore_query_documents('question_reports', 'uid', uid):
        firestore_delete_document(f'question_reports/{report["_document_id"]}')
    for report in firestore_query_documents('question_platform_reports', 'uid', uid):
        firestore_delete_document(
            f'question_platform_reports/{report["_document_id"]}')

    # تحديات App Attest غير المستخدمة لا تحمل UID خاماً، لكنها تبقى قابلة
    # للربط بالحساب عبر بصمة مخصصة. نحذفها فور حذف الحساب، بينما تتولى سياسة
    # Firestore TTL حذف أي تحدٍ منتهي لم يُستهلك أو يُحذف بهذه العملية.
    uid_hash = _app_attest_uid_hash(uid)
    for challenge in firestore_query_documents(
            'app_attest_challenges', 'uid_hash', uid_hash):
        firestore_delete_document(
            f'app_attest_challenges/{challenge["_document_id"]}')

    # أحداث RevenueCat تحتوي نسخة من payload ومعرّفات المعاملة. نحذف ما
    # يشير إلى uid مباشرةً، وما يتصل بمعرّف RevenueCat في rc_ids (مهم لأحداث
    # TRANSFER التي قد تُسند الوثيقة النهائية إلى الحساب الوجهة فقط).
    revenuecat_events = {
        document['_document_id']: document
        for document in firestore_query_documents('revenuecat_events', 'uid', uid)
    }
    for rc_app_user_id in rc_app_user_ids:
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
    for rc_app_user_id in rc_app_user_ids:
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


class RevenueCatIdentityConflictError(RuntimeError):
    """هوية RevenueCat مثبتة لحساب Firebase آخر."""


class RevenueCatIdentityEvidenceError(RuntimeError):
    """معرّف غير مربوط يحمل دليل webhook/استحقاق قديم."""


class RevenueCatV1BootstrapDisabledError(RuntimeError):
    """v1 يحاول إنشاء ربط جديد بمعرّف يختاره العميل."""


class RevenueCatStatusUnavailableError(RuntimeError):
    """تعذّر جلب الحالة الموثوقة من RevenueCat."""


def local_revenuecat_identity(uid: str):
    """اقرأ الربط المحلي السابق كدليل ترقية موثوق من الخادم."""
    conn = db_connect()
    try:
        row = conn.execute(
            'SELECT rc_app_user_id FROM revenuecat_identities WHERE uid=?',
            (uid,),
        ).fetchone()
        value = str(row[0] or '').strip().lower() if row else ''
        return value if is_valid_rc_app_user_id(value) else None
    finally:
        conn.close()


def cache_revenuecat_identity(uid: str, rc_app_user_id: str, *,
                              authoritative: bool = False) -> None:
    """حدّث كاش SQLite ذرياً.

    الوضع الافتراضي صارم للمسار المحلي. authoritative=True مسموح
    فقط بعد أن يثبت Firestore مالك المعرّف؛ عندها ننظف صفاً محلياً
    قديماً بدل ترك endpoint في حلقة 409 دائمة.
    """
    conn = db_connect()
    try:
        conn.execute('BEGIN IMMEDIATE')
        owner = conn.execute(
            'SELECT uid FROM revenuecat_identities WHERE rc_app_user_id=?',
            (rc_app_user_id,),
        ).fetchone()
        if owner and owner[0] != uid:
            if not authoritative:
                raise RevenueCatIdentityConflictError(
                    'هوية RevenueCat مرتبطة بحساب آخر')
            conn.execute(
                'DELETE FROM revenuecat_identities '
                'WHERE uid=? AND rc_app_user_id=?',
                (owner[0], rc_app_user_id),
            )
        conn.execute('''
            INSERT INTO revenuecat_identities (uid, rc_app_user_id)
            VALUES (?,?)
            ON CONFLICT(uid) DO UPDATE SET
                rc_app_user_id=excluded.rc_app_user_id,
                updated_at=CURRENT_TIMESTAMP
        ''', (uid, rc_app_user_id))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def cache_authoritative_revenuecat_identity_best_effort(
        uid: str, rc_app_user_id: str) -> None:
    """اعكس إثبات Firestore إلى SQLite من دون تعطيل المسار السحابي."""
    try:
        cache_revenuecat_identity(
            uid, rc_app_user_id, authoritative=True)
    except Exception as exc:
        # Firestore has already made the durable ownership decision. SQLite is
        # only a compatibility cache here, so a lock/corrupt stale row must not
        # turn a successful claim or trusted webhook into a permanent 503.
        print('[RevenueCat] local identity cache repair failed '
              f'uid_ref={safe_log_reference(uid)} '
              f'rc_ref={safe_log_reference(rc_app_user_id)}: '
              f'{exception_kind(exc)}')


def claim_local_revenuecat_identity(uid: str):
    """أعد ربط SQLite قائماً أو أنشئ UUID4 من الخادم داخل قفل كتابة."""
    conn = db_connect()
    try:
        conn.execute('BEGIN IMMEDIATE')
        row = conn.execute(
            'SELECT rc_app_user_id FROM revenuecat_identities WHERE uid=?',
            (uid,),
        ).fetchone()
        if row and is_valid_rc_app_user_id(str(row[0] or '')):
            conn.commit()
            return str(row[0]).lower()
        if row:
            raise RuntimeError('ربط RevenueCat المحلي غير صالح')

        # UUID collisions are extraordinarily unlikely, but the UNIQUE index
        # remains the authority and makes the decision safe under concurrency.
        for _ in range(5):
            candidate = str(uuid.uuid4()).lower()
            try:
                conn.execute('''
                    INSERT INTO revenuecat_identities (uid, rc_app_user_id)
                    VALUES (?,?)
                ''', (uid, candidate))
                conn.commit()
                return candidate
            except sqlite3.IntegrityError:
                # The transaction keeps the uid claim serialized. A conflict
                # here can only be a generated UUID already owned elsewhere.
                continue
        raise RuntimeError('تعذّر إنشاء هوية RevenueCat فريدة')
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def claim_v1_local_revenuecat_identity(uid: str, rc_app_user_id: str, *,
                                       allow_bootstrap: bool):
    """توافق v1 لعميل 1.2 الذي يهمل معرّف الاستجابة.

    المطالبة ذرية داخل BEGIN IMMEDIATE، وتُرفض إذا وجد الخادم
    حدث RevenueCat سابقاً للمعرّف قبل الربط.
    """
    conn = db_connect()
    try:
        conn.execute('BEGIN IMMEDIATE')
        owner = conn.execute(
            'SELECT uid FROM revenuecat_identities WHERE rc_app_user_id=?',
            (rc_app_user_id,),
        ).fetchone()
        if owner:
            if owner[0] != uid:
                raise RevenueCatIdentityConflictError(
                    'هوية RevenueCat مرتبطة بحساب آخر')
            conn.commit()
            return rc_app_user_id
        if not allow_bootstrap:
            raise RevenueCatV1BootstrapDisabledError(
                'يلزم الترقية إلى عقد RevenueCat v2 لربط جديد')
        evidence = conn.execute(
            'SELECT 1 FROM revenuecat_events WHERE rc_ids LIKE ? LIMIT 1',
            (f'%"{rc_app_user_id}"%',),
        ).fetchone()
        if evidence:
            raise RevenueCatIdentityEvidenceError(
                'هوية RevenueCat تحمل سجل اشتراك غير مربوط')
        # One uid keeps one local cache row. Existing v1 installations reuse
        # their server-side row; a fresh claim uses the exact ID configured by
        # the old SDK so the response cannot silently switch identities.
        current = conn.execute(
            'SELECT rc_app_user_id FROM revenuecat_identities WHERE uid=?',
            (uid,),
        ).fetchone()
        if current:
            conn.execute('''
                UPDATE revenuecat_identities
                SET rc_app_user_id=?, updated_at=CURRENT_TIMESTAMP
                WHERE uid=?
            ''', (rc_app_user_id, uid))
        else:
            conn.execute('''
                INSERT INTO revenuecat_identities (uid, rc_app_user_id)
                VALUES (?,?)
            ''', (uid, rc_app_user_id))
        conn.commit()
        return rc_app_user_id
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _revenuecat_identity_record(uid: str, rc_app_user_id: str) -> dict:
    return {
        'uid': uid,
        'rc_app_user_id': rc_app_user_id,
        'updated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }


def _ensure_firestore_revenuecat_forward(uid: str,
                                         rc_app_user_id: str) -> None:
    """أنشئ الربط الأمامي create-if-absent، ولا تكتب فوق مالك آخر."""
    path = f'revenuecat_identities/{rc_app_user_id}'
    existing = firestore_get_document(path)
    if existing:
        if existing.get('uid') != uid:
            raise RevenueCatIdentityConflictError(
                'هوية RevenueCat مرتبطة بحساب آخر')
        return
    created = firestore_create_document_if_absent(
        path, _revenuecat_identity_record(uid, rc_app_user_id))
    if created:
        return
    # Another instance won between GET and createDocument. Re-read the signed
    # server state; never infer ownership from the client's UUID.
    existing = firestore_get_document(path)
    if not existing or existing.get('uid') != uid:
        raise RevenueCatIdentityConflictError(
            'هوية RevenueCat مرتبطة بحساب آخر')


def claim_firestore_revenuecat_identity(uid: str, *, legacy_hint: str = '',
                                        trusted_local_id: str = ''):
    """أعد هوية RevenueCat الموثوقة، وأنشئ جديدة من الخادم فقط.

    revenuecat_users/{uid} هو قفل create-if-absent لمطالبة uid.
    حقل legacy_hint ليس إثبات ملكية: لا يُقبل إلا إذا أثبت Firestore أو
    SQLite أن الربط موجود مسبقاً للحساب نفسه.
    """
    reverse_path = f'revenuecat_users/{uid}'
    hint = str(legacy_hint or '').strip().lower()
    trusted_local_id = str(trusted_local_id or '').strip().lower()

    # Once the reverse document exists it is the sole canonical identity for
    # v2. A client hint may prove an old alias exists, but must never switch the
    # canonical mapping or make concurrent devices oscillate it.
    reverse = firestore_get_document(reverse_path)
    if reverse:
        canonical = str(reverse.get('rc_app_user_id') or '').strip().lower()
        if not is_valid_rc_app_user_id(canonical):
            raise RuntimeError('ربط RevenueCat السحابي غير صالح')
        _ensure_firestore_revenuecat_forward(uid, canonical)
        return canonical

    verified_legacy_id = ''
    if hint:
        hinted_mapping = firestore_get_document(
            f'revenuecat_identities/{hint}')
        if hinted_mapping:
            if hinted_mapping.get('uid') != uid:
                raise RevenueCatIdentityConflictError(
                    'هوية RevenueCat مرتبطة بحساب آخر')
            verified_legacy_id = hint
        elif hint == trusted_local_id:
            verified_legacy_id = hint

    if not verified_legacy_id and is_valid_rc_app_user_id(trusted_local_id):
        verified_legacy_id = trusted_local_id

    if verified_legacy_id:
        # Preserve an already-linked subscriber identity, including an older
        # device alias, while repairing either side of an incomplete migration.
        _ensure_firestore_revenuecat_forward(uid, verified_legacy_id)
        created = firestore_create_document_if_absent(
            reverse_path,
            _revenuecat_identity_record(uid, verified_legacy_id),
        )
        if created:
            return verified_legacy_id
        # A concurrent request may have established the canonical reverse
        # mapping after our initial read. The winner remains authoritative.
        reverse = firestore_get_document(reverse_path)
        canonical = str(
            (reverse or {}).get('rc_app_user_id') or '').strip().lower()
        if not is_valid_rc_app_user_id(canonical):
            raise RuntimeError('تعذّر قراءة ربط RevenueCat المتزامن')
        _ensure_firestore_revenuecat_forward(uid, canonical)
        return canonical

    # New identities are always server-generated. createDocument is the atomic
    # ownership decision; a losing request re-reads and uses the winner.
    for _ in range(5):
        candidate = str(uuid.uuid4()).lower()
        reverse_update_time = firestore_create_document_if_absent(
            reverse_path, _revenuecat_identity_record(uid, candidate))
        if not reverse_update_time:
            reverse = firestore_get_document(reverse_path)
            if not reverse:
                continue
            canonical = str(reverse.get('rc_app_user_id') or '').strip().lower()
            if not is_valid_rc_app_user_id(canonical):
                raise RuntimeError('ربط RevenueCat السحابي غير صالح')
            _ensure_firestore_revenuecat_forward(uid, canonical)
            return canonical
        try:
            _ensure_firestore_revenuecat_forward(uid, candidate)
            return candidate
        except RevenueCatIdentityConflictError:
            # UUID collision: release only the exact reverse document created
            # by this attempt, then retry with a fresh server UUID.
            if not firestore_delete_document_if_update_time(
                    reverse_path, reverse_update_time):
                raise RuntimeError('تعذّر التراجع عن ربط RevenueCat متعارض')
    raise RuntimeError('تعذّر إنشاء هوية RevenueCat فريدة')


def _firestore_revenuecat_id_has_evidence(rc_app_user_id: str) -> bool:
    """لا تُسند مشتريات/webhooks سابقة إلى مطالبة v1 لاحقة."""
    if firestore_list_documents(
            f'revenuecat_pending/{rc_app_user_id}/events'):
        return True
    return bool(firestore_query_documents(
        'revenuecat_events', 'rc_ids', rc_app_user_id,
        op='ARRAY_CONTAINS'))


def claim_v1_firestore_revenuecat_identity(uid: str,
                                           rc_app_user_id: str, *,
                                           allow_bootstrap: bool):
    """حارس توافق محدود لعميل 1.2 القديم.

    v1 يكوّن RevenueCat بـUUID الطلب ويهمل body الاستجابة؛ لذلك
    لا يمكن إرجاع UUID خادمي مختلف من دون كسر الاشتراك. نحجز الاسم
    بـcreate-if-absent، ونرفض معرّفاً له أي دليل webhook/شراء سابق.
    يبقى revenuecat_users/{uid} معرّف v2 القياسي ولا يتذبذب؛ أما معرّفات
    v1 الإضافية فتُحفظ كروابط أمامية (aliases) يحلّها webhook للـuid نفسه،
    ويحذفها مسار حذف الحساب جميعاً باستعلام uid.
    """
    forward_path = f'revenuecat_identities/{rc_app_user_id}'
    existing = firestore_get_document(forward_path)
    if existing:
        if existing.get('uid') != uid:
            raise RevenueCatIdentityConflictError(
                'هوية RevenueCat مرتبطة بحساب آخر')
        reverse_path = f'revenuecat_users/{uid}'
        if not firestore_get_document(reverse_path):
            firestore_create_document_if_absent(
                reverse_path,
                _revenuecat_identity_record(uid, rc_app_user_id),
            )
        return rc_app_user_id
    reverse_path = f'revenuecat_users/{uid}'
    reverse = firestore_get_document(reverse_path)
    reverse_id = str(
        (reverse or {}).get('rc_app_user_id') or '').strip().lower()
    if reverse_id == rc_app_user_id:
        # A partial prior write already proves ownership server-side. Repairing
        # its missing forward document is not a client-selected bootstrap.
        _ensure_firestore_revenuecat_forward(uid, rc_app_user_id)
        return rc_app_user_id
    if not allow_bootstrap:
        raise RevenueCatV1BootstrapDisabledError(
            'يلزم الترقية إلى عقد RevenueCat v2 لربط جديد')
    if _firestore_revenuecat_id_has_evidence(rc_app_user_id):
        raise RevenueCatIdentityEvidenceError(
            'هوية RevenueCat تحمل سجل اشتراك غير مربوط')

    reverse_update_time = ''
    if not reverse:
        reverse_update_time = firestore_create_document_if_absent(
            reverse_path,
            _revenuecat_identity_record(uid, rc_app_user_id),
        ) or ''
    try:
        _ensure_firestore_revenuecat_forward(uid, rc_app_user_id)
    except Exception:
        if reverse_update_time:
            firestore_delete_document_if_update_time(
                reverse_path, reverse_update_time)
        raise
    return rc_app_user_id


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
                # Firestore is authoritative here; heal stale local ownership
                # best-effort without blocking a trusted webhook on SQLite.
                cache_authoritative_revenuecat_identity_best_effort(
                    uid, rc_app_user_id)
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
            print('[RevenueCat] replay failed '
                  f'event_ref={safe_log_reference(document.get("event_id"))}: '
                  f'{exception_kind(exc)}')
    return replayed


def _parse_revenuecat_datetime(value):
    """حوّل تاريخ RevenueCat إلى UTC؛ القيمة غير الصالحة لا تُعامل كاشتراك."""
    if not isinstance(value, str) or not value.strip():
        return None
    normalized = value.strip()
    if normalized.endswith('Z'):
        normalized = normalized[:-1] + '+00:00'
    try:
        parsed = datetime.datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise RevenueCatStatusUnavailableError(
            'تاريخ استحقاق RevenueCat غير صالح') from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    return parsed.astimezone(datetime.timezone.utc)


def _revenuecat_entitlement_snapshot(payload: dict) -> tuple[bool, str | None]:
    """استخرج حالة premium من Customer Info كما أعادتها RevenueCat."""
    subscriber = payload.get('subscriber') if isinstance(payload, dict) else None
    entitlements = subscriber.get('entitlements') if isinstance(subscriber, dict) else None
    entitlement_id = (
        os.environ.get('REVENUECAT_ENTITLEMENT_ID', 'premium').strip()
        or 'premium')
    entitlement = entitlements.get(entitlement_id) if isinstance(entitlements, dict) else None
    if not isinstance(entitlement, dict):
        return False, None

    expires_raw = entitlement.get('expires_date')
    grace_raw = entitlement.get('grace_period_expires_date')
    if expires_raw is None and grace_raw is None:
        # RevenueCat يمثل الاستحقاق الدائم بتاريخ انتهاء null.
        return True, None
    boundaries = [
        parsed for parsed in (
            _parse_revenuecat_datetime(expires_raw),
            _parse_revenuecat_datetime(grace_raw),
        ) if parsed is not None
    ]
    if not boundaries:
        raise RevenueCatStatusUnavailableError(
            'استحقاق RevenueCat بلا تاريخ انتهاء قابل للتحقق')
    effective_expiration = max(boundaries)
    active = effective_expiration > datetime.datetime.now(datetime.timezone.utc)
    return active, effective_expiration.strftime('%Y-%m-%d %H:%M:%S')


def _authoritative_revenuecat_identity(uid: str) -> str:
    """اقرأ App User ID من الربط الخادمي فقط، ولا تقبل قيمة من العميل."""
    if firestore_durable_available():
        reverse = firestore_get_document(f'revenuecat_users/{uid}') or {}
        rc_app_user_id = str(reverse.get('rc_app_user_id') or '').strip().lower()
    else:
        rc_app_user_id = str(local_revenuecat_identity(uid) or '').strip().lower()
    return rc_app_user_id if is_valid_rc_app_user_id(rc_app_user_id) else ''


def _persist_verified_revenuecat_subscription(uid: str, active: bool,
                                               expires_at=None) -> None:
    """احفظ نتيجة REST الموثوقة في Firestore والكاش المحلي بصورة متطابقة."""
    status = 'active' if active else 'inactive'
    verified_at = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    record = {
        'uid': uid,
        'status': status,
        'expires_at': expires_at,
        'revenuecat_verified_at': verified_at,
        'updated_at': verified_at,
    }
    if firestore_durable_available():
        firestore_set_document(f'subscriptions/{uid}', record)
    elif durable_storage_required():
        raise RevenueCatStatusUnavailableError(
            'التخزين الدائم غير متاح لحفظ حالة RevenueCat')

    conn = db_connect()
    try:
        conn.execute('''INSERT INTO subscriptions (uid, status, expires_at)
            VALUES (?,?,?)
            ON CONFLICT(uid) DO UPDATE SET
            status=excluded.status,
            expires_at=excluded.expires_at,
            updated_at=CURRENT_TIMESTAMP''', (uid, status, expires_at))
        conn.commit()
    finally:
        conn.close()


def refresh_revenuecat_subscription(uid: str):
    """زامن الاستحقاق مباشرة من RevenueCat عند تأخر أو فقدان webhook.

    الاستعلام يستخدم UUID المثبت في الخادم ومفتاح API من البيئة. لا يثق بأي
    حالة اشتراك أو App User ID قادمة من التطبيق.
    """
    api_key = (
        os.environ.get('REVENUECAT_SECRET_API_KEY', '').strip()
        or os.environ.get('REVENUECAT_IOS_API_KEY', '').strip())
    if not api_key:
        return None
    rc_app_user_id = _authoritative_revenuecat_identity(uid)
    if not rc_app_user_id:
        return None
    url = (
        'https://api.revenuecat.com/v1/subscribers/'
        + urllib.parse.quote(rc_app_user_id, safe=''))
    request = urllib.request.Request(url, method='GET', headers={
        'Authorization': f'Bearer {api_key}',
        'Accept': 'application/json',
        'X-Platform': 'ios',
    })
    try:
        with urllib.request.urlopen(request, timeout=6) as response:
            raw = response.read(262_145)
            if response.status != 200 or len(raw) > 262_144:
                raise RevenueCatStatusUnavailableError(
                    f'RevenueCat HTTP {response.status}')
        payload = json.loads(raw.decode('utf-8'))
    except urllib.error.HTTPError as exc:
        raise RevenueCatStatusUnavailableError(
            f'RevenueCat HTTP {exc.code}') from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError,
            UnicodeDecodeError) as exc:
        raise RevenueCatStatusUnavailableError(
            'تعذّر الاتصال بخدمة RevenueCat') from exc
    active, expires_at = _revenuecat_entitlement_snapshot(payload)
    _persist_verified_revenuecat_subscription(uid, active, expires_at)
    return active


def try_refresh_revenuecat_subscription(uid: str):
    """مزامنة best-effort لمسار الوصول مع سجل آمن بلا معرفات مباشرة."""
    try:
        return refresh_revenuecat_subscription(uid)
    except Exception as exc:
        print('[RevenueCat] status refresh failed '
              f'uid_ref={safe_log_reference(uid)}: {exception_kind(exc)}')
        return None

# ─── قراءة index.html ────────────────────────────────────────────────────────
def read_html():
    with open(HTML_FILE, 'rb') as f:
        return f.read()


def production_landing_html() -> bytes:
    """Public game catalogue; the iOS application remains private."""
    return public_site.landing_html()

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


class Handler(BaseHTTPRequestHandler):
    _api_version = '1'

    def setup(self):
        super().setup()
        original_reader = self.rfile
        self._deadline_reader = DeadlineSocketReader(
            self.connection,
            getattr(self.server, 'request_timeout_seconds',
                    HTTP_REQUEST_TIMEOUT_SECONDS))
        self.rfile = io.BufferedReader(self._deadline_reader)
        original_reader.close()

    def handle_one_request(self):
        # The deadline is absolute for the whole request line, headers and body;
        # receiving another byte never extends it. Reset only for a genuinely
        # new keep-alive request.
        self._deadline_reader.reset_deadline()
        return super().handle_one_request()

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

    def send_json(self, code, obj, *, extra_headers=None):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type',   'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Access-Control-Expose-Headers',
                         f'{API_VERSION_HEADER}, X-Fatinah-Environment')
        self.send_header(API_VERSION_HEADER, getattr(self, '_api_version', '1'))
        self.send_header('X-Fatinah-Environment', deployment_environment())
        self.send_header('Vary', API_VERSION_HEADER)
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def select_api_contract(self, path: str):
        try:
            canonical_path, version = resolve_api_contract(path, self.headers)
        except ValueError as exc:
            self._api_version = '1'
            self.send_json(400, {
                'error': str(exc),
                'code': 'unsupported_api_version',
            })
            return None
        self._api_version = version
        return canonical_path

    def api_feature_allows(self, path: str) -> bool:
        if path in REMOVED_CONTENT_ROUTES:
            self.send_json(410, {
                'error': 'أزيلت الأسئلة والفئات من تحديث 1.4',
                'code': 'question_content_removed',
            })
            return False
        if self._api_version != '2':
            if path in V2_ONLY_ROUTES:
                self.send_json(404, {
                    'error': 'المسار متاح في عقد API v2 فقط',
                    'code': 'v2_route_required',
                })
                return False
            return True
        if path not in V2_ROUTE_FEATURES:
            self.send_json(404, {
                'error': 'المسار غير معرّف في عقد API v2',
                'code': 'unsupported_v2_route',
            })
            return False
        feature = V2_ROUTE_FEATURES[path]
        if feature is None or v2_feature_enabled(feature):
            return True
        self.send_json(503, {
            'error': 'الميزة غير مفعلة في هذه البيئة',
            'code': 'feature_disabled',
            'feature': feature,
        })
        return False

    def app_integrity_allows(self, path: str) -> bool:
        valid, reason = verify_app_check_header(self.headers, path)
        # Destructive handlers may require a positively verified App Check
        # token even while the global rollout remains in monitor mode.
        self._app_check_valid = valid
        if valid:
            return True
        if app_check_enforcement_enabled(self._api_version):
            self.send_json(401, {
                'error': 'تعذّر التحقق من سلامة نسخة التطبيق',
                'code': 'app_check_failed',
            })
            return False
        # الإطلاق التدريجي: راقب النسبة أولاً ثم فعّل الإنفاذ من البيئة.
        print(f'[App Check] monitor path={path} reason={reason}')
        return True

    def require_quality_admin(self, *, mutation=False) -> bool:
        if not admin_session_valid(self.headers):
            self.send_json(401, {
                'error': 'جلسة لوحة الجودة مطلوبة',
                'code': 'admin_session_required',
            })
            return False
        if mutation and not admin_origin_valid(self.headers):
            self.send_json(403, {
                'error': 'مصدر طلب لوحة الجودة مرفوض',
                'code': 'admin_origin_rejected',
            })
            return False
        return True

    def verified_player(self, data):
        if not isinstance(data, dict):
            self.send_json(400, {'error': 'JSON غير صالح'})
            return None
        uid = str(data.get('uid') or '').strip()
        id_token = str(
            data.get('idToken') or bearer_token(self.headers) or '').strip()
        identity = verified_uid_token(uid, id_token) if uid else None
        if not identity:
            self.send_json(401, {
                'error': 'رمز الدخول غير صالح',
                'code': 'player_auth_required',
            })
            return None
        return uid, identity

    def do_OPTIONS(self):
        parsed = urllib.parse.urlparse(self.path)
        path = self.select_api_contract(parsed.path)
        if path is None:
            return
        if not self.api_feature_allows(path):
            return
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin',  '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers',
                         'Content-Type, Authorization, X-Firebase-AppCheck, '
                         f'{API_VERSION_HEADER}, X-DeviceCheck-Token, '
                         'X-App-Attest-Key-Id, X-App-Attest-Challenge-Id, '
                         'X-App-Attest-Assertion, X-App-Attest-Request-Hash')
        self.send_header(API_VERSION_HEADER, self._api_version)
        self.send_header('X-Fatinah-Environment', deployment_environment())
        self.send_header('Vary', API_VERSION_HEADER)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = self.select_api_contract(parsed.path)
        if path is None:
            return
        params = urllib.parse.parse_qs(parsed.query)

        if not self.api_feature_allows(path):
            return
        if not self.app_integrity_allows(path):
            return

        if public_site.serve(self, path):
            return

        # أزيلت أكواد التفعيل الخاصة امتثالاً لسياسة مشتريات Apple. أي عروض
        # ترويجية يجب أن تمر عبر StoreKit Offer Codes فقط.
        if path == '/admin/promo' or path.startswith('/api/promo/'):
            self.send_json(410, {'error': 'تم إيقاف أكواد التفعيل الخاصة؛ استخدم Apple Offer Codes'}); return

        if path == '/admin/quality':
            self.send_response(302)
            self.send_header('Location', '/admin/quality/')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()

        elif path == '/admin/quality/':
            full_path = os.path.join(os.path.dirname(__file__), 'admin', 'index.html')
            try:
                with open(full_path, 'rb') as file:
                    self.send_asset(file.read(), 'text/html; charset=utf-8', 'no-store',
                                    extra_headers={'Content-Security-Policy': WEB_CONTENT_SECURITY_POLICY})
            except OSError:
                self.send_response(404); self.end_headers()

        elif path in {'/admin/quality/app.js', '/admin/quality/app.css'}:
            filename = path.rsplit('/', 1)[-1]
            full_path = os.path.join(os.path.dirname(__file__), 'admin', filename)
            try:
                with open(full_path, 'rb') as file:
                    content_type = ('application/javascript; charset=utf-8'
                                    if filename.endswith('.js') else 'text/css; charset=utf-8')
                    self.send_asset(file.read(), content_type, 'no-store')
            except OSError:
                self.send_response(404); self.end_headers()

        elif path == '/api/admin/setup-status':
            configured = admin_password_configured()
            self.send_json(200, {
                'configured': configured,
                'localSetupAllowed': (
                    not configured
                    and deployment_environment() != 'production'
                    and client_is_loopback(self.client_address)
                ),
            })

        elif path == '/api/admin/session':
            self.send_json(200, {'authenticated': admin_session_valid(self.headers)})

        elif path == '/api/admin/dashboard':
            if not self.require_quality_admin(): return
            try:
                sync_question_platform_questions()
                self.send_json(200, question_platform.dashboard(DB_PATH))
            except QuestionPlatformStorageError:
                self.send_json(503, {'error': 'تعذرت قراءة مخزن الجودة',
                                     'code': 'question_storage_unavailable'})

        elif path == '/api/admin/questions':
            if not self.require_quality_admin(): return
            try:
                sync_question_platform_questions()
                level = int((params.get('level') or ['0'])[0])
                limit = int((params.get('limit') or ['100'])[0])
                offset = int((params.get('offset') or ['0'])[0])
            except ValueError:
                self.send_json(400, {'error': 'معاملات القائمة غير صالحة'}); return
            except QuestionPlatformStorageError:
                self.send_json(503, {'error': 'تعذرت قراءة مخزن الجودة',
                                     'code': 'question_storage_unavailable'}); return
            self.send_json(200, question_platform.list_questions(
                DB_PATH,
                status=str((params.get('status') or [''])[0]),
                level=level,
                search=str((params.get('search') or [''])[0]),
                limit=limit, offset=offset,
            ))

        elif path == '/api/admin/reports':
            if not self.require_quality_admin(): return
            try:
                sync_question_platform_reports()
                self.send_json(200, {'items': question_platform.list_reports(DB_PATH)})
            except QuestionPlatformStorageError:
                self.send_json(503, {'error': 'تعذرت قراءة البلاغات',
                                     'code': 'question_storage_unavailable'})

        elif path == '/api/admin/audit':
            if not self.require_quality_admin(): return
            self.send_json(200, {'items': question_platform.audit_log(
                DB_PATH, str((params.get('questionId') or [''])[0]))})

        elif path == '/api/version':
            self.send_json(200, {
                'apiVersion': self._api_version,
                'applicationRelease': APPLICATION_RELEASE,
                'contractRevision': API_CONTRACT_REVISION,
                'environment': deployment_environment(),
                'unversionedDefault': '1',
                'supportedVersions': ['1', '2'],
                'features': (
                    {name: v2_feature_enabled(name)
                     for name in sorted({value for value in V2_ROUTE_FEATURES.values()
                                         if value is not None})}
                    if self._api_version == '2'
                    else {'questionPlatform': 'v2'}
                ),
            })

        elif path == '/api/rc-config':
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
            if not admin_secret or not secrets.compare_digest(auth_header, admin_secret):
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
                    print('[Subscription] Firestore read failed '
                          f'uid_ref={safe_log_reference(uid)}: {exception_kind(exc)}')
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
            if not active:
                refreshed = try_refresh_revenuecat_subscription(uid)
                if refreshed is not None:
                    active = refreshed is True
                    source = 'revenuecat'
            self.send_json(200, {'active': active, 'source': source})

        elif path == '/api/free-round/status':
            uid = (params.get('uid') or [''])[0].strip()
            if not uid:
                self.send_json(400, {'error': 'uid مطلوب'}); return
            if not uid_matches_token(uid, bearer_token(self.headers)):
                self.send_json(401, {'error': 'رمز الدخول غير صالح — سجّل دخولك مرة أخرى'}); return
            installation_completed = False
            if app_attest_enforcement_enabled(self._api_version):
                key_id = (self.headers.get('X-App-Attest-Key-Id', '') or '').strip()
                challenge_id = (
                    self.headers.get('X-App-Attest-Challenge-Id', '') or '').strip()
                assertion = (
                    self.headers.get('X-App-Attest-Assertion', '') or '').strip()
                request_hash = (
                    self.headers.get('X-App-Attest-Request-Hash', '') or '').strip()
                device_token_for_hash = (
                    self.headers.get('X-DeviceCheck-Token', '') or '').strip()
                expected_hash = free_round_app_attest_request_hash(
                    uid, device_token_for_hash)
                if request_hash != expected_hash:
                    self.send_json(401, {
                        'error': 'إثبات App Attest لا يطابق طلب الجولة',
                        'code': 'app_attest_context_mismatch',
                    }); return
                try:
                    verify_app_attest_assertion(
                        uid=uid, key_id=key_id,
                        challenge_id=challenge_id, assertion=assertion,
                        purpose='free_round_status', request_hash=request_hash,
                    )
                    installation_claim = app_attest_installation_claim(key_id)
                    installation_access = app_attest_installation_claim_access(
                        key_id, uid, installation_claim)
                    # pending للحساب نفسه قابل للاسترداد؛ أما مطالبة حساب آخر
                    # أو مطالبة مكتملة فتجعلان العرض غير متاح.
                    installation_completed = installation_access in {
                        'conflict', 'owned_completed',
                    }
                except AppAttestValidationError as exc:
                    print('[App Attest] free-round status rejected: '
                          f'{exception_kind(exc)}')
                    self.send_json(401, {
                        'error': 'تعذّر التحقق من تثبيت التطبيق',
                        'code': 'app_attest_invalid',
                    }); return
                except (AppAttestStorageError,
                        DeviceCheckConfigurationError) as exc:
                    print('[App Attest] free-round status unavailable: '
                          f'{type(exc).__name__}')
                    self.send_json(503, {
                        'error': 'تعذّر التحقق من تثبيت التطبيق الآن',
                        'code': 'app_attest_unavailable',
                    }); return
            device_completed = False
            if devicecheck_enforcement_enabled(self._api_version):
                device_token = (self.headers.get('X-DeviceCheck-Token', '') or '').strip()
                if not device_token:
                    self.send_json(401, {
                        'error': 'تعذّر التحقق من أهلية الجهاز للجولة المجانية',
                        'code': 'device_check_missing',
                    }); return
                try:
                    device_state = devicecheck_request('query_two_bits', device_token)
                except ValueError:
                    self.send_json(400, {
                        'error': 'رمز DeviceCheck غير صالح',
                        'code': 'device_check_invalid',
                    }); return
                except DeviceCheckConfigurationError as exc:
                    print(f'[DeviceCheck] configuration error: {exception_kind(exc)}')
                    self.send_json(503, {
                        'error': 'التحقق من الجولة المجانية غير مجهّأ على الخادم',
                        'code': 'device_check_not_configured',
                    }); return
                except DeviceCheckServiceError as exc:
                    print(f'[DeviceCheck] query failed: {exception_kind(exc)}')
                    self.send_json(503, {
                        'error': 'تعذّر التحقق من أهلية الجهاز الآن',
                        'code': 'device_check_unavailable',
                    }); return
                if device_state.get('bit1') is True:
                    self.send_json(403, {
                        'error': 'هذا الجهاز غير مؤهل للعرض المجاني',
                        'code': 'device_flagged',
                    }); return
                device_completed = device_state.get('bit0') is True
            account_completed = False
            use_local_account_claim = not firestore_durable_available()
            if not use_local_account_claim:
                try:
                    document = firestore_get_document(f'free_rounds/{uid}')
                    account_completed = bool(
                        document and document.get('completed') is True)
                    if account_completed:
                        conn = db_connect()
                        try:
                            conn.execute('INSERT OR IGNORE INTO free_rounds (uid) VALUES (?)', (uid,))
                            conn.commit()
                        finally:
                            conn.close()
                except Exception as exc:
                    print('[Free Round] Firestore read failed '
                          f'uid_ref={safe_log_reference(uid)}: {exception_kind(exc)}')
                    if durable_storage_required():
                        self.send_json(503, {'error': 'تعذّر التحقق من الجولة المجانية الآن'}); return
            if use_local_account_claim:
                conn = db_connect()
                try:
                    account_completed = bool(conn.execute(
                        'SELECT 1 FROM free_rounds WHERE uid=?', (uid,)
                    ).fetchone())
                finally:
                    conn.close()
            completed = (installation_completed or device_completed
                         or account_completed)
            self.send_json(200, {'eligible': not completed, 'completed': completed})

        elif path in ('/', '/index.html'):
            # حزمة iOS تحمل ملفات اللعبة محلياً. تقديمها على الويب في
            # production يجعل Boolean داخل JavaScript هو حاجز الاشتراك، وهو
            # قابل للتعديل من DevTools. الموقع العام يعرض صفحة تعريف فقط.
            body = (read_html() if public_web_game_enabled()
                    else production_landing_html())
            # طبقة دفاع إضافية ضد XSS: تمنع تحميل سكربتات خارجية وتقيّد
            # الوجهات التي يمكن لأي كود مُدرَج أن يرسل لها بيانات.
            self.send_asset(
                body, 'text/html; charset=utf-8', 'no-cache',
                extra_headers={'Content-Security-Policy': (WEB_CONTENT_SECURITY_POLICY
                               if public_web_game_enabled() else public_site.CSP)})

        elif path in ('/app.js', '/app.css',
                      '/privacy-policy.html', '/terms-of-service.html'):
            fname = path.lstrip('/')
            game_assets = {'app.js', 'app.css'}
            if not public_web_game_enabled() and fname in game_assets:
                self.send_json(404, {
                    'error': 'اللعبة متاحة من تطبيق فطنة الرسمي على App Store',
                    'code': 'ios_app_only',
                })
                return
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
                extra_headers = (
                    {'Content-Security-Policy': LEGAL_CONTENT_SECURITY_POLICY}
                    if fname.endswith('.html') else None
                )
                self.send_asset(
                    body, ctype, cache_control, extra_headers=extra_headers)
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
                      '/legal/privacy.html', '/legal/terms.html', '/legal/styles.css',
                      '/legal/language-toggle.js', '/robots.txt'):
            fname = {
                '/privacy': 'privacy.html', '/terms': 'terms.html',
                '/legal': 'index.html', '/legal/': 'index.html', '/legal/index.html': 'index.html',
                '/legal/privacy.html': 'privacy.html', '/legal/terms.html': 'terms.html',
                '/legal/styles.css': 'styles.css',
                '/legal/language-toggle.js': 'language-toggle.js',
                '/robots.txt': 'robots.txt',
            }[path]
            ctype = ('application/javascript; charset=utf-8' if fname.endswith('.js')
                     else 'text/css; charset=utf-8' if fname.endswith('.css')
                     else 'text/plain; charset=utf-8' if fname.endswith('.txt')
                     else 'text/html; charset=utf-8')
            try:
                with open(os.path.join(os.path.dirname(__file__), 'legal', fname), 'rb') as f:
                    body = f.read()
                extra_headers = (
                    {'Content-Security-Policy': LEGAL_CONTENT_SECURITY_POLICY}
                    if fname.endswith('.html') else None
                )
                self.send_asset(
                    body, ctype, 'no-cache', extra_headers=extra_headers)
            except FileNotFoundError:
                self.send_response(404); self.end_headers()

        elif path == '/download/index.html':
            if not public_web_game_enabled():
                self.send_json(404, {
                    'error': 'التطبيق متاح عبر App Store فقط',
                    'code': 'ios_app_only',
                })
                return
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
            if not admin_secret or not secrets.compare_digest(auth_header, admin_secret):
                self.send_json(403, {'error': 'غير مصرح'}); return
            self.send_json(200, _startup_status)

        elif path == '/api/admin/metrics':
            admin_secret = os.environ.get('ADMIN_SECRET', '')
            auth_header = self.headers.get('X-Admin-Secret', '')
            if not admin_secret or not secrets.compare_digest(auth_header, admin_secret):
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
            finally:
                conn.close()
            self.send_json(200, {
                'days': days,
                'events': {name: count for name, count in event_rows},
            })

        else:
            self.send_response(404); self.end_headers()

    # حدود حجم body لكل نقطة POST — تُعيد 413 مبكراً قبل قراءة البيانات
    _MAX_BODY: dict = {
        '/api/account/delete':          4_096,   # 4 KB   (uid + idToken)
        '/api/revenuecat/webhook':     65_536,   # 64 KB  (حدث RevenueCat)
        '/api/revenuecat/identity':     2_048,   # uid + UUID + token
        '/api/account/profile':         2_048,   # 2 KB   (name + email + provider)
        '/api/app-attest/challenge':     4_096,
        '/api/app-attest/attest':      262_144,  # CBOR x5c + receipt بصيغة Base64
        '/api/free-round/complete':     64_000,  # DeviceCheck + App Attest assertion
        '/api/metrics/event':            4_096,
        '/api/ios-diagnostics':        655_360,
        '/api/admin/login':              4_096,
        '/api/admin/setup':              4_096,
        '/api/admin/logout':             1_024,
        '/api/admin/questions':        131_072,
        '/api/admin/question-status':    8_192,
        '/api/admin/report-status':      8_192,
        '/api/game/packs/ensure':         8_192,
        '/api/game/packs/start':          4_096,
        '/api/game/packs/complete':      65_536,
        '/api/game/questions/report':    32_768,
    }
    _DEFAULT_MAX_BODY = 16_384  # 16 KB للمسارات غير المدرجة

    def max_body_for(self, path: str) -> int:
        return self._MAX_BODY.get(path, self._DEFAULT_MAX_BODY)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = self.select_api_contract(parsed.path)
        if path is None:
            return

        if not self.api_feature_allows(path):
            return

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

        max_allowed = self.max_body_for(path)
        if length > max_allowed:
            self.send_json(413, {'error': f'حجم الطلب كبير جداً (الحد: {max_allowed} بايت)'}); return

        body   = self.rfile.read(length)

        if not self.app_integrity_allows(path):
            return

        if path == '/api/admin/setup':
            if (deployment_environment() == 'production'
                    or not client_is_loopback(self.client_address)
                    or not admin_origin_valid(self.headers)):
                self.send_json(403, {
                    'error': 'الإعداد الأولي متاح من الجهاز المحلي فقط',
                    'code': 'local_setup_required',
                }); return
            if admin_password_configured():
                self.send_json(409, {
                    'error': 'تم إعداد كلمة الدخول مسبقاً',
                    'code': 'admin_already_configured',
                }); return
            try:
                data = json.loads(body)
                password = str(data.get('password') or '') if isinstance(data, dict) else ''
                confirmation = str(data.get('confirmation') or '') if isinstance(data, dict) else ''
            except Exception:
                self.send_json(400, {'error': 'JSON غير صالح'}); return
            if not secrets.compare_digest(password, confirmation):
                self.send_json(422, {
                    'error': 'كلمتا الدخول غير متطابقتين',
                    'code': 'password_confirmation_mismatch',
                }); return
            peer = safe_log_reference(self.client_address[0] if self.client_address else '')
            if rate_limited(f'quality-setup:{peer}', 5, 900):
                self.send_json(429, {'error': 'محاولات كثيرة — حاول لاحقاً'}); return
            try:
                create_local_admin_password(password)
            except ValueError as exc:
                self.send_json(422, {
                    'error': str(exc), 'code': 'weak_admin_password',
                    'issues': admin_password_issues(password),
                }); return
            except RuntimeError as exc:
                self.send_json(409, {
                    'error': str(exc), 'code': 'admin_already_configured',
                }); return
            self.send_json(201, {'configured': True}); return

        if path == '/api/admin/login':
            try:
                data = json.loads(body)
            except Exception:
                self.send_json(400, {'error': 'JSON غير صالح'}); return
            supplied = str(data.get('password') or '') if isinstance(data, dict) else ''
            peer = safe_log_reference(self.client_address[0] if self.client_address else '')
            if rate_limited(f'quality-login:{peer}', 8, 900):
                self.send_json(429, {'error': 'محاولات دخول كثيرة'}); return
            if not verify_admin_password(supplied):
                self.send_json(401, {'error': 'كلمة دخول غير صالحة'}); return
            self.send_json(200, {'authenticated': True}, extra_headers={
                'Set-Cookie': create_admin_session_cookie(),
            }); return

        if path == '/api/admin/logout':
            self.send_json(200, {'authenticated': False}, extra_headers={
                'Set-Cookie': clear_admin_session_cookie(),
            }); return

        if path == '/api/admin/questions':
            if not self.require_quality_admin(mutation=True): return
            try:
                sync_question_platform_questions()
                data = json.loads(body)
                saved = question_platform.save_question(
                    DB_PATH, data, actor='quality-admin')
                try:
                    persist_question_platform_question(saved)
                except QuestionPlatformStorageError:
                    question_platform.set_question_status(
                        DB_PATH, saved['questionId'], 'paused', actor='storage-failsafe')
                    raise
                self.send_json(200, saved)
            except question_platform.ValidationError as exc:
                self.send_json(exc.status, {
                    'error': str(exc), 'code': exc.code, 'issues': exc.issues,
                })
            except QuestionPlatformStorageError:
                self.send_json(503, {'error': 'تعذر حفظ السؤال في المخزن الدائم',
                                     'code': 'question_storage_unavailable'})
            return

        if path == '/api/admin/question-status':
            if not self.require_quality_admin(mutation=True): return
            try:
                sync_question_platform_questions()
                data = json.loads(body)
                updated = question_platform.set_question_status(
                    DB_PATH, str(data.get('questionId') or ''),
                    str(data.get('status') or ''), actor='quality-admin')
                try:
                    persist_question_platform_question(updated)
                except QuestionPlatformStorageError:
                    question_platform.set_question_status(
                        DB_PATH, updated['questionId'], 'paused', actor='storage-failsafe')
                    raise
                self.send_json(200, updated)
            except question_platform.QuestionPlatformError as exc:
                self.send_json(exc.status, {
                    'error': str(exc), 'code': exc.code,
                    'issues': getattr(exc, 'issues', []),
                })
            except QuestionPlatformStorageError:
                self.send_json(503, {'error': 'تعذر حفظ حالة السؤال',
                                     'code': 'question_storage_unavailable'})
            return

        if path == '/api/admin/report-status':
            if not self.require_quality_admin(mutation=True): return
            try:
                sync_question_platform_reports()
                data = json.loads(body)
                updated = question_platform.resolve_report(
                    DB_PATH, str(data.get('reportId') or ''),
                    resolved=data.get('resolved') is not False)
                persist_question_platform_report(updated)
                self.send_json(200, updated)
            except question_platform.QuestionPlatformError as exc:
                self.send_json(exc.status, {'error': str(exc), 'code': exc.code}); return
            except QuestionPlatformStorageError:
                self.send_json(503, {'error': 'تعذر حفظ حالة البلاغ',
                                     'code': 'question_storage_unavailable'}); return
            return

        if path in {
            '/api/game/packs/readiness', '/api/game/packs/ensure', '/api/game/packs/start',
            '/api/game/packs/complete', '/api/game/questions/report',
        }:
            try:
                data = json.loads(body)
            except Exception:
                self.send_json(400, {'error': 'JSON غير صالح'}); return
            verified = self.verified_player(data)
            if not verified: return
            uid, identity = verified
            if rate_limited(f'game-platform:{path}:{safe_log_reference(uid)}', 90, 600):
                self.send_json(429, {'error': 'طلبات كثيرة — حاول بعد قليل'}); return
            try:
                if path == '/api/game/packs/readiness':
                    # هذا الفحص لا يحجز أسئلة ولا يستهلك الجولة المجانية؛ الغرض
                    # منع استهلاكها قبل التأكد من اكتمال 100 سؤال لكل مستوى.
                    sync_question_platform_questions()
                    readiness = question_platform.dashboard(DB_PATH)
                    self.send_json(200, {'ready': bool(readiness['launchReady'])})
                    return
                if path == '/api/game/packs/ensure':
                    is_subscriber = subscription_is_active(uid)
                    if not is_subscriber and not question_access_allowed(uid):
                        self.send_json(403, {
                            'error': 'يلزم اشتراك فعّال أو جولة تعريفية',
                            'code': 'subscription_or_free_round_required',
                        }); return
                    guard = acquire_question_platform_guard(uid)
                    try:
                        sync_question_platform_questions()
                        sync_question_platform_user(uid)
                        result = question_platform.ensure_packs(
                            DB_PATH, uid, data.get('playerCount'),
                            data.get('questionsPerPlayer'), data.get('target', 2),
                            introductory=not is_subscriber)
                        persist_question_platform_user(uid)
                    finally:
                        release_question_platform_guard(guard)
                    self.send_json(200, result); return
                if path == '/api/game/packs/start':
                    guard = acquire_question_platform_guard(uid)
                    try:
                        sync_question_platform_user(uid)
                        result = question_platform.start_pack(
                            DB_PATH, uid, str(data.get('packId') or ''))
                        persist_question_platform_user(uid)
                    finally:
                        release_question_platform_guard(guard)
                    self.send_json(200, result); return
                if path == '/api/game/packs/complete':
                    guard = acquire_question_platform_guard(uid)
                    try:
                        sync_question_platform_user(uid)
                        result = question_platform.complete_pack(
                            DB_PATH, uid, str(data.get('packId') or ''),
                            data.get('usedReplacementIds'), data.get('outcomes'))
                        persist_question_platform_user(uid)
                        persist_question_platform_metrics(
                            item.get('questionId') for item in (data.get('outcomes') or [])
                            if isinstance(item, dict))
                    finally:
                        release_question_platform_guard(guard)
                    self.send_json(200, result); return

                sync_question_platform_questions()
                reporter = {
                    'name': identity.get('displayName') or data.get('reporterName') or '',
                    'email': identity.get('email') or '',
                }
                created = question_platform.create_report(
                    DB_PATH, uid, reporter, data)
                report = question_platform.pending_report(DB_PATH, created['reportId'])
                persist_question_platform_report(report)
                try:
                    email_status = deliver_question_report_email(report)
                except Exception as exc:
                    email_status = 'failed'
                    print('[Question Report] email delivery failed '
                          f'report_ref={safe_log_reference(created["reportId"])}: '
                          f'{exception_kind(exc)}')
                question_platform.set_report_email_status(
                    DB_PATH, created['reportId'], email_status)
                report = question_platform.pending_report(DB_PATH, created['reportId'])
                persist_question_platform_report(report)
                persist_question_platform_metrics([data.get('questionId')])
                self.send_json(202, {
                    'ok': True, 'reportId': created['reportId'],
                }); return
            except question_platform.BankNotReadyError as exc:
                self.send_json(exc.status, {
                    'error': str(exc), 'code': exc.code,
                    'availability': exc.availability,
                }); return
            except question_platform.QuestionPlatformError as exc:
                self.send_json(exc.status, {
                    'error': str(exc), 'code': exc.code,
                    'issues': getattr(exc, 'issues', []),
                }); return
            except QuestionPlatformBusyError:
                self.send_json(409, {'error': 'جهاز آخر يجهّز الجولة، حاول بعد لحظات',
                                     'code': 'question_pack_busy'}); return
            except QuestionPlatformStorageError:
                self.send_json(503, {'error': 'تعذرت مزامنة سجل الأسئلة الآمن',
                                     'code': 'question_storage_unavailable'}); return

        if path in {
            '/api/app-attest/status', '/api/app-attest/challenge',
            '/api/app-attest/attest',
        }:
            if self._api_version != '2':
                self.send_json(404, {
                    'error': 'App Attest متاح في عقد API v2 فقط',
                    'code': 'app_attest_v2_only',
                })
                return
            try:
                data = json.loads(body)
            except Exception:
                self.send_json(400, {'error': 'JSON غير صالح'}); return
            if not isinstance(data, dict):
                self.send_json(400, {'error': 'JSON غير صالح'}); return
            uid = str(data.get('uid') or '').strip()
            id_token = str(
                data.get('idToken') or bearer_token(self.headers) or '').strip()
            key_id = str(data.get('keyId') or '').strip()
            if not uid or not key_id:
                self.send_json(400, {
                    'error': 'uid وkeyId مطلوبان',
                    'code': 'app_attest_input_missing',
                }); return
            if not uid_matches_token(uid, id_token):
                self.send_json(401, {
                    'error': 'رمز الدخول غير صالح — سجّل دخولك مرة أخرى',
                }); return
            if rate_limited(f'app-attest:{path}:{uid}', 20, 600):
                self.send_json(429, {
                    'error': 'طلبات App Attest كثيرة جداً — حاول لاحقاً',
                }); return
            try:
                _app_attest_key_material(key_id)
                if path == '/api/app-attest/status':
                    key_record = get_app_attest_key(key_id)
                    self.send_json(200, {
                        'attested': bool(key_record),
                    })
                    return

                if path == '/api/app-attest/challenge':
                    purpose = str(data.get('purpose') or '').strip()
                    request_hash = str(data.get('requestHash') or '').strip()
                    key_record = get_app_attest_key(key_id)
                    if purpose == 'attest' and key_record:
                        self.send_json(409, {
                            'error': 'مفتاح App Attest مسجّل مسبقاً',
                            'code': 'app_attest_already_registered',
                        }); return
                    if purpose != 'attest' and not key_record:
                        self.send_json(409, {
                            'error': 'يجب تسجيل مفتاح App Attest أولاً',
                            'code': 'app_attest_not_registered',
                        }); return
                    challenge = create_app_attest_challenge(
                        uid, key_id, purpose, request_hash)
                    self.send_json(201, challenge)
                    return

                verify_app_attest_attestation(
                    uid=uid,
                    key_id=key_id,
                    challenge_id=str(data.get('challengeId') or ''),
                    attestation_object=str(data.get('attestationObject') or ''),
                )
                self.send_json(201, {'attested': True})
                return
            except AppAttestValidationError as exc:
                print(f'[App Attest] rejected path={path}: {exception_kind(exc)}')
                self.send_json(401, {
                    'error': 'تعذّر التحقق من سلامة تثبيت التطبيق',
                    'code': 'app_attest_invalid',
                }); return
            except (AppAttestStorageError, DeviceCheckConfigurationError) as exc:
                print(f'[App Attest] unavailable path={path}: {type(exc).__name__}')
                self.send_json(503, {
                    'error': 'خدمة سلامة التطبيق غير متاحة مؤقتاً',
                    'code': 'app_attest_unavailable',
                }); return

        # بنك 1.3 مراجع مسبقاً ويُسحب عند بدء الجولة؛ لا يوجد توليد AI للاعب.
        # الوصول خاص بمشترك مسجّل ومتحقق الهوية، أو باستحقاق جولة
        # مجانية مثبتة. لا يتحول هذا المسار إلى منفذ عام لاستخراج المحتوى.
        if path == '/api/free-round/complete':
            try: data = json.loads(body)
            except Exception: self.send_json(400, {'error': 'JSON غير صالح'}); return
            if not isinstance(data, dict):
                self.send_json(400, {'error': 'JSON غير صالح'}); return
            uid = str(data.get('uid') or '').strip()
            id_token = str(data.get('idToken') or bearer_token(self.headers) or '').strip()
            if not uid:
                self.send_json(400, {'error': 'uid مطلوب'}); return
            if not uid_matches_token(uid, id_token):
                self.send_json(401, {'error': 'رمز الدخول غير صالح — سجّل دخولك مرة أخرى'}); return
            if rate_limited(f'free-round:{uid}', 10, 600):
                self.send_json(429, {'error': 'طلبات كثيرة جداً — حاول بعد قليل'}); return
            device_token = str(
                data.get('deviceCheckToken')
                or self.headers.get('X-DeviceCheck-Token', '')
                or ''
            ).strip()
            update_token = str(data.get('deviceCheckUpdateToken') or '').strip()
            app_attest_key_id = ''
            installation_access = 'missing'
            if app_attest_enforcement_enabled(self._api_version):
                app_attest_key_id = str(data.get('appAttestKeyId') or '').strip()
                request_hash = str(
                    data.get('appAttestRequestHash') or '').strip()
                expected_hash = free_round_app_attest_request_hash(
                    uid, device_token, update_token)
                if request_hash != expected_hash:
                    self.send_json(401, {
                        'error': 'إثبات App Attest لا يطابق طلب الجولة',
                        'code': 'app_attest_context_mismatch',
                    }); return
                try:
                    verify_app_attest_assertion(
                        uid=uid,
                        key_id=app_attest_key_id,
                        challenge_id=str(
                            data.get('appAttestChallengeId') or ''),
                        assertion=str(data.get('appAttestAssertion') or ''),
                        purpose='free_round_complete',
                        request_hash=request_hash,
                    )
                    installation_claim = app_attest_installation_claim(
                        app_attest_key_id)
                    installation_access = app_attest_installation_claim_access(
                        app_attest_key_id, uid, installation_claim)
                    if installation_access == 'conflict':
                        self.send_json(409, {
                            'error': 'استُخدمت الجولة المجانية لهذا التثبيت',
                            'code': 'free_round_installation_already_claimed',
                            'completed': True,
                        }); return
                except AppAttestValidationError as exc:
                    print('[App Attest] free-round claim rejected: '
                          f'{exception_kind(exc)}')
                    self.send_json(401, {
                        'error': 'تعذّر التحقق من تثبيت التطبيق',
                        'code': 'app_attest_invalid',
                    }); return
                except (AppAttestStorageError,
                        DeviceCheckConfigurationError) as exc:
                    print('[App Attest] free-round claim unavailable: '
                          f'{type(exc).__name__}')
                    self.send_json(503, {
                        'error': 'تعذّر التحقق من تثبيت التطبيق الآن',
                        'code': 'app_attest_unavailable',
                    }); return
            if installation_access == 'owned_completed':
                try:
                    # يصلح سجل UID إن اكتملت مطالبة التثبيت في محاولة سابقة
                    # ثم تعطل حفظ سجل الحساب أو ضاع الرد على العميل.
                    persist_free_round_completion(uid)
                except Exception as exc:
                    print('[Free Round] completed installation recovery failed: '
                          f'{type(exc).__name__}')
                    self.send_json(503, {
                        'error': 'تعذّر استرداد الجولة المثبتة الآن؛ حاول مرة أخرى',
                        'code': 'free_round_claim_persistence_failed',
                    }); return
                self.send_json(200, {
                    'ok': True, 'completed': True, 'alreadyClaimed': True,
                }); return
            if devicecheck_enforcement_enabled(self._api_version):
                if not device_token:
                    self.send_json(401, {
                        'error': 'تعذّر التحقق من الجهاز قبل بدء الجولة',
                        'code': 'device_check_missing',
                    }); return
                if not update_token:
                    self.send_json(401, {
                        'error': 'تعذّر تأكيد الجهاز قبل بدء الجولة',
                        'code': 'device_check_update_token_missing',
                    }); return
                claim_guard = None
                try:
                    # القفل يبقى ممسوكاً حتى حفظ ربط الحساب وإكمال مطالبة
                    # التثبيت. مطالبة pending تُنشأ قبل تغيير Apple، فتغلق
                    # نافذة التعطل بعد update_two_bits وقبل Firestore.
                    claim_guard = acquire_devicecheck_claim_guard()
                    device_state = devicecheck_request('query_two_bits', device_token)
                    if device_state.get('bit1') is True:
                        self.send_json(403, {
                            'error': 'هذا الجهاز غير مؤهل للعرض المجاني',
                            'code': 'device_flagged',
                        }); return
                    device_was_already_claimed = device_state.get('bit0') is True
                    if device_was_already_claimed:
                        # pending موجودة من محاولة سابقة للحساب نفسه هي دليل
                        # الاسترداد بعد أن غيّرت Apple bit0 وضاع حفظ Firestore.
                        if installation_access == 'owned_pending':
                            same_account = True
                        else:
                            same_account = False
                            if firestore_durable_available():
                                try:
                                    document = firestore_get_document(
                                        f'free_rounds/{uid}')
                                    same_account = bool(
                                        document
                                        and document.get('completed') is True)
                                except Exception as exc:
                                    raise DeviceCheckServiceError(
                                        'تعذّر قراءة مالك الجولة المجانية') from exc
                            elif (deployment_environment() == 'production'
                                  or durable_storage_required()):
                                raise DeviceCheckConfigurationError(
                                    'ملكية الجولة المجانية تحتاج Firestore')
                            else:
                                conn = db_connect()
                                try:
                                    same_account = bool(conn.execute(
                                        'SELECT 1 FROM free_rounds WHERE uid=?',
                                        (uid,)).fetchone())
                                finally:
                                    conn.close()
                        if not same_account:
                            self.send_json(409, {
                                'error': 'استُخدمت الجولة المجانية على هذا الجهاز',
                                'code': 'free_round_already_claimed',
                                'completed': True,
                            }); return
                        # سجل UID قديم موثوق يسمح بترقية تثبيت لم يكن له سجل
                        # App Attest بعد، من دون منح الجولة لحساب جديد.
                        if app_attest_key_id and installation_access == 'missing':
                            installation_access = (
                                reserve_app_attest_installation_claim(
                                    app_attest_key_id, uid))
                            if installation_access == 'conflict':
                                self.send_json(409, {
                                    'error': 'استُخدمت الجولة المجانية لهذا التثبيت',
                                    'code': 'free_round_installation_already_claimed',
                                    'completed': True,
                                }); return
                    else:
                        # لا نغيّر bit0 إلا بعد نجاح الحجز الدائم. إذا تعطل
                        # الحفظ هنا فلا يتغير شيء لدى Apple ويمكن إعادة الطلب.
                        if app_attest_key_id:
                            installation_access = (
                                reserve_app_attest_installation_claim(
                                    app_attest_key_id, uid))
                            if installation_access == 'conflict':
                                self.send_json(409, {
                                    'error': 'استُخدمت الجولة المجانية لهذا التثبيت',
                                    'code': 'free_round_installation_already_claimed',
                                    'completed': True,
                                }); return
                            if installation_access == 'owned_completed':
                                # سجل التثبيت هو المرجع هنا؛ لا نعيد تغيير
                                # Apple، ونمر بمسار الإصلاح الموحّد أدناه.
                                device_was_already_claimed = True
                        # bit0 مخصص لفطنة: تم استهلاك العرض التعريفي على الجهاز.
                        # نستخدم token جديداً لعملية التحديث كما توصي Apple.
                        if installation_access != 'owned_completed':
                            devicecheck_request(
                                'update_two_bits', update_token, bit0=True)

                    try:
                        # الترتيب مقصود: UID أولاً، ثم completed. عند أي فشل
                        # تبقى pending باسم بصمة المالك، فيسترد الحساب نفسه
                        # المحاولة ويُمنع أي حساب آخر من الاستحواذ عليها.
                        persist_free_round_completion(uid)
                        if app_attest_key_id:
                            complete_app_attest_installation_claim(
                                app_attest_key_id, uid)
                    except AppAttestValidationError:
                        self.send_json(409, {
                            'error': 'تغير مالك مطالبة التثبيت',
                            'code': 'free_round_installation_already_claimed',
                            'completed': True,
                        }); return
                    except Exception as exc:
                        print('[Free Round] recoverable persistence failure: '
                              f'{type(exc).__name__}')
                        self.send_json(503, {
                            'error': 'تم حجز الجولة وتعذّر تثبيتها؛ حاول مرة أخرى',
                            'code': 'free_round_claim_persistence_failed',
                        }); return
                    response = {'ok': True, 'completed': True}
                    if device_was_already_claimed:
                        response['alreadyClaimed'] = True
                    self.send_json(200, response)
                    return
                except ValueError:
                    self.send_json(400, {
                        'error': 'رمز DeviceCheck غير صالح',
                        'code': 'device_check_invalid',
                    }); return
                except DeviceCheckClaimBusyError:
                    self.send_json(503, {
                        'error': 'يجري تأكيد جولة أخرى الآن — حاول مرة ثانية',
                        'code': 'free_round_claim_busy',
                    }); return
                except AppAttestStorageError as exc:
                    print('[App Attest] installation claim failed: '
                          f'{type(exc).__name__}')
                    self.send_json(503, {
                        'error': 'تعذّر تثبيت مطالبة الجولة الآن',
                        'code': 'app_attest_unavailable',
                    }); return
                except DeviceCheckConfigurationError as exc:
                    print(f'[DeviceCheck] configuration error: {exception_kind(exc)}')
                    self.send_json(503, {
                        'error': 'التحقق من الجولة المجانية غير مجهّأ على الخادم',
                        'code': 'device_check_not_configured',
                    }); return
                except DeviceCheckServiceError as exc:
                    print(f'[DeviceCheck] claim failed: {exception_kind(exc)}')
                    self.send_json(503, {
                        'error': 'تعذّر تأكيد الجولة المجانية الآن',
                        'code': 'device_check_unavailable',
                    }); return
                finally:
                    if claim_guard is not None:
                        release_devicecheck_claim_guard(claim_guard)
            if app_attest_key_id:
                try:
                    installation_access = reserve_app_attest_installation_claim(
                        app_attest_key_id, uid)
                except AppAttestStorageError as exc:
                    print('[App Attest] installation claim failed: '
                          f'{type(exc).__name__}')
                    self.send_json(503, {
                        'error': 'تعذّر تثبيت مطالبة الجولة الآن',
                        'code': 'app_attest_unavailable',
                    }); return
                if installation_access == 'conflict':
                    self.send_json(409, {
                        'error': 'استُخدمت الجولة المجانية لهذا التثبيت',
                        'code': 'free_round_installation_already_claimed',
                        'completed': True,
                    }); return
            try:
                persist_free_round_completion(uid)
                if app_attest_key_id:
                    complete_app_attest_installation_claim(
                        app_attest_key_id, uid)
            except Exception as exc:
                print('[Free Round] durable write failed '
                      f'uid_ref={safe_log_reference(uid)}: {exception_kind(exc)}')
                self.send_json(503, {
                    'error': 'تعذّر حفظ الجولة بأمان — ستتم إعادة المحاولة',
                    'code': 'free_round_claim_persistence_failed',
                }); return
            self.send_json(200, {'ok': True, 'completed': True})

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
                print('[Metrics] durable write failed '
                      f'event_ref={safe_log_reference(event_id)}: '
                      f'{exception_kind(exc)}')
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
            privacy_scope = str(data.get('privacyScope') or '').strip()
            schema_version = data.get('schemaVersion')

            # 1.3 يرسل MetricKit بلا UID إطلاقاً: App Check يثبت أن الطلب من
            # نسخة أصلية، بينما لا نربط تقريراً يغطي نافذة زمنية سابقة بحساب
            # قد يكون دخل لاحقاً على الجهاز نفسه. يبقى عقد v1 كما هو لتوافق
            # النسخة المنشورة.
            if self._api_version == '2':
                app_check_valid, _ = verify_app_check_header(self.headers, path)
                if not app_check_valid:
                    self.send_json(401, {
                        'error': 'تعذّر التحقق من سلامة نسخة التطبيق',
                        'code': 'app_check_required',
                    }); return
                if uid or data.get('idToken') is not None:
                    self.send_json(400, {
                        'error': 'تقارير التشخيص المجهولة لا تقبل هوية مستخدم',
                        'code': 'diagnostic_identity_forbidden',
                    }); return
                if (schema_version != 2 or privacy_scope != 'anonymous'
                        or not re.fullmatch(r'[0-9a-f]{64}', report_id)):
                    self.send_json(400, {'error': 'نطاق خصوصية تقرير iOS غير صالح'}); return
                if not payload or len(payload.encode()) > 512_000:
                    self.send_json(400, {'error': 'تقرير iOS غير صالح'}); return
                try:
                    decoded_payload = base64.b64decode(payload, validate=True)
                    decoded_json = json.loads(decoded_payload)
                    if not isinstance(decoded_json, dict):
                        raise ValueError('payload root')
                except Exception:
                    self.send_json(400, {'error': 'حمولة تقرير iOS غير صالحة'}); return
                # بصمة مؤقتة لرمز App Check توزع الحد حتى خلف reverse proxy،
                # من دون حفظ الرمز نفسه أو ربط التقرير بحساب/جهاز دائم.
                app_check_token = str(
                    self.headers.get('X-Firebase-AppCheck', '') or '')
                rate_identity = hashlib.sha256(
                    app_check_token.encode('utf-8')).hexdigest()[:24]
                if rate_limited(
                        f'ios-diagnostics-anonymous:{rate_identity}', 40, 3600):
                    self.send_json(429, {'error': 'طلبات تقارير كثيرة جداً'}); return
                retention = ios_diagnostic_retention_fields()
                record = {
                    'report_id': report_id,
                    'schema_version': schema_version,
                    'privacy_scope': privacy_scope,
                    'report_type': report_type,
                    'payload': payload,
                    'app_version': app_version,
                    **retention,
                }
                if report_type not in {'metric', 'diagnostic'}:
                    self.send_json(400, {'error': 'تقرير iOS غير صالح'}); return
                try:
                    durable_write(
                        f'ios_diagnostics_anonymous/{report_id}', record, merge=False)
                except Exception as exc:
                    print('[MetricKit] durable anonymous write failed '
                          f'report_ref={safe_log_reference(report_id)}: '
                          f'{exception_kind(exc)}')
                    self.send_json(503, {'error': 'تعذّر حفظ تقرير التشخيص بأمان'}); return
                conn = db_connect()
                try:
                    conn.execute(
                        "DELETE FROM ios_diagnostics "
                        "WHERE created_at < datetime('now', ?)",
                        (f'-{IOS_DIAGNOSTIC_RETENTION_DAYS} days',),
                    )
                    conn.execute('''INSERT OR IGNORE INTO ios_diagnostics
                        (report_id, uid, schema_version, privacy_scope,
                         report_type, payload, app_version)
                        VALUES (?,?,?,?,?,?,?)''',
                        (report_id, '', schema_version, privacy_scope,
                         report_type, payload, app_version))
                    conn.commit()
                finally:
                    conn.close()
                self.send_json(202, {'ok': True, 'reportId': report_id})
                return

            if not uid or not uid_matches_token(uid, id_token):
                self.send_json(401, {'error': 'رمز الدخول غير صالح — سجّل دخولك مرة أخرى'}); return
            if (not re.fullmatch(r'[A-Za-z0-9-]{20,64}', report_id)
                    or report_type not in {'metric', 'diagnostic'}
                    or not payload or len(payload.encode()) > 512_000):
                self.send_json(400, {'error': 'تقرير iOS غير صالح'}); return
            if rate_limited(f'ios-diagnostics:{uid}', 40, 3600):
                self.send_json(429, {'error': 'طلبات تقارير كثيرة جداً'}); return
            retention = ios_diagnostic_retention_fields()
            record = {
                'report_id': report_id,
                'uid': uid,
                'report_type': report_type,
                'payload': payload,
                'app_version': app_version,
                **retention,
            }
            try:
                durable_write(f'users/{uid}/ios_diagnostics/{report_id}', record, merge=False)
            except Exception as exc:
                print('[MetricKit] durable write failed '
                      f'report_ref={safe_log_reference(report_id)}: '
                      f'{exception_kind(exc)}')
                self.send_json(503, {'error': 'تعذّر حفظ تقرير التشخيص بأمان'}); return
            conn = db_connect()
            try:
                conn.execute(
                    "DELETE FROM ios_diagnostics "
                    "WHERE created_at < datetime('now', ?)",
                    (f'-{IOS_DIAGNOSTIC_RETENTION_DAYS} days',),
                )
                conn.execute('''INSERT OR IGNORE INTO ios_diagnostics
                    (report_id, uid, report_type, payload, app_version)
                    VALUES (?,?,?,?,?)''',
                    (report_id, uid, report_type, payload, app_version))
                conn.commit()
            finally:
                conn.close()
            self.send_json(202, {'ok': True, 'reportId': report_id})

        # ─── حذف الحساب: إزالة كل بيانات المستخدم المرتبطة بالـ uid ──────────
        elif path == '/api/account/delete':
            try:   data = json.loads(body)
            except Exception: self.send_json(400, {'error': 'JSON غير صالح'}); return
            if not isinstance(data, dict):
                self.send_json(400, {'error': 'JSON غير صالح'}); return

            uid = str(data.get('uid') or '').strip()
            id_token = str(data.get('idToken') or '').strip()
            if not uid: self.send_json(400, {'error': 'uid مطلوب'}); return

            # الحذف عملية مدمّرة: لا يكفي token صالح لحساب مرتبط؛
            # يجب أن يكون auth_time حديثاً. استثناء Anonymous محمي بـv2
            # وApp Check فعلي لأن Firebase لا يوفر له credential للـreauth.
            authorized, auth_code = authorize_account_delete(
                uid,
                id_token,
                api_version=self._api_version,
                app_check_valid=bool(getattr(self, '_app_check_valid', False)),
            )
            if not authorized:
                messages = {
                    'recent_auth_required': (
                        'يلزم تسجيل الدخول مجدداً قبل حذف الحساب'),
                    'anonymous_app_check_required': (
                        'تعذّر التحقق من سلامة نسخة التطبيق'),
                }
                self.send_json(401, {
                    'error': messages.get(
                        auth_code,
                        'رمز الدخول غير صالح — سجّل دخولك مرة أخرى'),
                    'code': auth_code,
                })
                return
            if rate_limited(f'account-delete:{uid}', 5, 3600):
                self.send_json(429, {
                    'error': 'طلبات حذف كثيرة جداً — حاول لاحقاً'
                }); return

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
                    'player_question_cycles',
                    'player_question_seen',
                    'game_packs',
                    'game_pack_questions',
                    'player_question_reports',
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
                    print('[Account Delete] فشل حذف Firestore '
                          f'uid_ref={safe_log_reference(uid)}: {exception_kind(exc)}')
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

            if not isinstance(data, dict):
                self.send_json(400, {'error': 'JSON غير صالح'}); return
            uid = str(data.get('uid') or '').strip()
            name = str(data.get('name') or '').strip()[:60]
            id_token = str(data.get('idToken') or bearer_token(self.headers) or '').strip()
            if not uid: self.send_json(400, {'error': 'uid مطلوب'}); return

            identity = verified_uid_token(uid, id_token)
            if not identity:
                self.send_json(401, {'error': 'رمز الدخول غير صالح — سجّل دخولك مرة أخرى'}); return
            email = str(identity.get('email') or '').strip()[:200]
            provider = str(identity.get('signInProvider') or '').strip()[:30]
            name = str(identity.get('displayName') or name).strip()[:60]
            if rate_limited(f'account-profile:{uid}', 30, 600):
                self.send_json(429, {
                    'error': 'طلبات تحديث كثيرة جداً — حاول لاحقاً'
                }); return

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
                print('[Profile] durable write failed '
                      f'uid_ref={safe_log_reference(uid)}: {exception_kind(exc)}')
                self.send_json(503, {'error': 'تعذّر حفظ الملف الشخصي بأمان'})

        # ─── ربط RevenueCat UUID بحساب Firebase ─────────────────────────────
        elif path == '/api/revenuecat/identity':
            try:
                data = json.loads(body)
            except Exception:
                self.send_json(400, {'error': 'JSON غير صالح'}); return
            if not isinstance(data, dict):
                self.send_json(400, {'error': 'JSON غير صالح'}); return

            uid = str(data.get('uid') or '').strip()
            id_token = str(data.get('idToken') or '').strip()
            old_client_id = str(data.get('rcAppUserId') or '').strip().lower()
            legacy_hint = str(
                data.get('legacyRcAppUserId') or old_client_id or '').strip().lower()
            if not uid:
                self.send_json(400, {'error': 'uid مطلوب'}); return
            if legacy_hint and not is_valid_rc_app_user_id(legacy_hint):
                self.send_json(400, {'error': 'UUID RevenueCat غير صالح'}); return
            if self._api_version == '1' and not is_valid_rc_app_user_id(old_client_id):
                self.send_json(400, {'error': 'UUID RevenueCat غير صالح'}); return
            if not uid_matches_token(uid, id_token):
                self.send_json(401, {'error': 'رمز الدخول غير صالح — سجّل دخولك مرة أخرى'}); return
            if rate_limited(f'revenuecat-identity:{uid}', 20, 600):
                self.send_json(429, {
                    'error': 'طلبات ربط كثيرة جداً — حاول لاحقاً'
                }); return

            try:
                if firestore_durable_available():
                    if self._api_version == '1':
                        # Compatibility for 1.2: that client configures the SDK
                        # with its request UUID and ignores this response body.
                        rc_app_user_id = claim_v1_firestore_revenuecat_identity(
                            uid, old_client_id,
                            allow_bootstrap=v1_revenuecat_bootstrap_enabled(),
                        )
                    else:
                        trusted_local_id = local_revenuecat_identity(uid) or ''
                        rc_app_user_id = claim_firestore_revenuecat_identity(
                            uid,
                            legacy_hint=legacy_hint,
                            trusted_local_id=trusted_local_id,
                        )
                    cache_authoritative_revenuecat_identity_best_effort(
                        uid, rc_app_user_id)
                elif durable_storage_required():
                    self.send_json(503, {
                        'error': 'التخزين الدائم غير مهيأ'
                    }); return
                elif self._api_version == '1':
                    rc_app_user_id = claim_v1_local_revenuecat_identity(
                        uid, old_client_id,
                        allow_bootstrap=v1_revenuecat_bootstrap_enabled(),
                    )
                else:
                    rc_app_user_id = claim_local_revenuecat_identity(uid)
            except RevenueCatV1BootstrapDisabledError as exc:
                self.send_json(426, {
                    'error': str(exc),
                    'code': 'revenuecat_v2_upgrade_required',
                })
                return
            except (RevenueCatIdentityConflictError,
                    RevenueCatIdentityEvidenceError) as exc:
                code = ('revenuecat_identity_has_prior_evidence'
                        if isinstance(exc, RevenueCatIdentityEvidenceError)
                        else 'revenuecat_identity_conflict')
                self.send_json(409, {
                    'error': str(exc),
                    'code': code,
                })
                return
            except sqlite3.OperationalError:
                self.send_json(503, {
                    'error': 'قاعدة البيانات مشغولة — حاول بعد لحظات'
                })
                return
            except Exception as exc:
                print('[RevenueCat] identity durable write failed '
                      f'uid_ref={safe_log_reference(uid)}: {exception_kind(exc)}')
                self.send_json(503, {
                    'error': 'تعذّر حفظ ربط الاشتراك بأمان'
                })
                return

            replayed = 0
            if firestore_durable_available():
                try:
                    replayed = replay_pending_revenuecat_events(rc_app_user_id)
                except Exception as exc:
                    # الربط محفوظ؛ سيعيد webhook أو نداء الربط القادم المعالجة.
                    print('[RevenueCat] pending replay failed '
                          f'rc_ref={safe_log_reference(rc_app_user_id)}: '
                          f'{exception_kind(exc)}')
            self.send_json(200, {
                'ok': True,
                'rcAppUserId': rc_app_user_id,
                'replayed': replayed,
            })


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
            # webhook موثّق لكنه يكتب حالة اشتراك وصندوق وارد. حد عالمي واسع
            # يحمي Firestore من سر مسرّب/عميل معطوب ولا يعيق retries الطبيعية.
            if rate_limited('revenuecat-webhook', 600, 60):
                self.send_json(429, {
                    'error': 'أحداث كثيرة جداً — ستتم إعادة المحاولة'
                }); return
            try:
                status, response = process_revenuecat_event(event)
                self.send_json(status, response)
            except Exception as exc:
                # RevenueCat يعيد أحداث 5xx بنفس event.id؛ لا نُرجع 2xx قبل
                # اكتمال الكتابة الدائمة حتى لا يضيع الاستحقاق.
                print('[RevenueCat] durable processing failed: '
                      f'{exception_kind(exc)}')
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
        return None, exception_kind(e)

def _firestore_http_error_details(exc):
    """اقرأ حالة Google مرة واحدة من دون الاحتفاظ بالنص الخام الحساس."""
    if not isinstance(exc, urllib.error.HTTPError):
        return '', ''
    cached = getattr(exc, '_fatinah_firestore_error_details', None)
    if cached is not None:
        return cached
    try:
        raw = exc.read().decode('utf-8', errors='replace')
        details = json.loads(raw).get('error') or {}
        status = str(details.get('status') or '').strip()
        reason = ''
        for item in details.get('details') or []:
            if item.get('@type', '').endswith('ErrorInfo'):
                reason = str(item.get('reason') or '').strip()
                break
    except Exception:
        status, reason = '', ''
    finally:
        exc.close()
    result = (status, reason)
    setattr(exc, '_fatinah_firestore_error_details', result)
    return result


def _firestore_precondition_failed(exc) -> bool:
    """Enterprise Firestore يعيد stale updateTime كـ HTTP 400 أحياناً."""
    if not isinstance(exc, urllib.error.HTTPError) or exc.code != 400:
        return False
    status, _reason = _firestore_http_error_details(exc)
    return status == 'FAILED_PRECONDITION'


def _firestore_http_error(exc, operation='request'):
    """استخرج الحالة/السبب فقط؛ رسالة Google قد تحمل مسار حساب أو مستند."""
    if not isinstance(exc, urllib.error.HTTPError):
        return f'Firestore {operation} error: {exception_kind(exc)}'
    status, reason = _firestore_http_error_details(exc)
    if not status and not reason:
        return f'Firestore HTTP {exc.code}: تعذّر قراءة تفاصيل الخطأ'
    suffix = f' ({reason})' if reason else ''
    return f'Firestore HTTP {exc.code}: {status or "HTTP_ERROR"}{suffix}'

class DeadlineSocketReader(io.RawIOBase):
    """Socket reader with a non-sliding deadline for one complete HTTP request."""

    def __init__(self, connection, timeout_seconds):
        super().__init__()
        self.connection = connection
        self.timeout_seconds = timeout_seconds
        self.deadline = 0.0
        self.reset_deadline()

    def readable(self):
        return True

    def fileno(self):
        return self.connection.fileno()

    def reset_deadline(self):
        self.deadline = time.monotonic() + self.timeout_seconds

    def readinto(self, buffer):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('HTTP request read deadline exceeded')
        self.connection.settimeout(remaining)
        return self.connection.recv_into(buffer)


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    request_timeout_seconds = HTTP_REQUEST_TIMEOUT_SECONDS
    max_worker_threads = HTTP_MAX_WORKER_THREADS
    max_connections_per_ip = HTTP_MAX_CONNECTIONS_PER_IP

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._worker_slots = threading.BoundedSemaphore(self.max_worker_threads)
        self._client_slots_lock = threading.Lock()
        self._client_slot_counts = {}

    def _acquire_client_slot(self, client_address):
        client_ip = str(client_address[0])
        with self._client_slots_lock:
            count = self._client_slot_counts.get(client_ip, 0)
            if count >= self.max_connections_per_ip:
                return False
            self._client_slot_counts[client_ip] = count + 1
            return True

    def _release_client_slot(self, client_address):
        client_ip = str(client_address[0])
        with self._client_slots_lock:
            count = self._client_slot_counts.get(client_ip, 0)
            if count <= 1:
                self._client_slot_counts.pop(client_ip, None)
            else:
                self._client_slot_counts[client_ip] = count - 1

    def get_request(self):
        request, client_address = super().get_request()
        request.settimeout(self.request_timeout_seconds)
        return request, client_address

    def process_request(self, request, client_address):
        # Reject excess connections before ThreadingMixIn allocates another
        # thread. Existing requests recover automatically through the socket
        # timeout above, including incomplete headers and slow POST bodies.
        if not self._worker_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        if not self._acquire_client_slot(client_address):
            self._worker_slots.release()
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._release_client_slot(client_address)
            self._worker_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._release_client_slot(client_address)
            self._worker_slots.release()

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
        print(f'[OUTBOX] تعذّر الإضافة إلى الـ outbox: {exception_kind(e)}')

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
                print('[OUTBOX] ✅ أُرسل السجل إلى Firestore '
                      f'uid_ref={safe_log_reference(uid)}.')
            except Exception as e:
                delay = min(2 ** attempts * 60, 3600)
                conn = db_connect()
                conn.execute(
                    "UPDATE subscription_outbox SET attempts=attempts+1, last_error=?, "
                    "next_retry=datetime('now','+'||?||' seconds') WHERE id=?",
                    (exception_kind(e), delay, row_id))
                conn.commit()
                conn.close()
                print('[OUTBOX] ❌ فشل السجل '
                      f'uid_ref={safe_log_reference(uid)} '
                      f'(محاولة {attempts+1}): {exception_kind(e)}')

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
        return count, f'SQLite upsert error: {exception_kind(e)}'
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

# ─── تشغيل ───────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    init_db()
    init_outbox_table()
    _run_startup_recovery()
    _threading.Thread(target=_outbox_worker, daemon=True).start()
    server = ThreadedHTTPServer(('0.0.0.0', PORT), Handler)
    print(f'فطنة تعمل على http://0.0.0.0:{PORT}')
    server.serve_forever()
