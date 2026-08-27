"""
خادم فطنة — Python خفيف مع Firebase Admin للتحقق المحلي من الرموز.
يخدم index.html وfirebase-config.js ويدير اشتراكات Apple IAP عبر RevenueCat.
أسئلة اللعبة تصدر من بنك محتوى ثابت ومراجع؛ لا يوجد توليد آلي للمستخدم.
"""
import base64, datetime, gzip, hashlib, io, ipaddress, json, os, secrets, socket, sqlite3, threading, time, urllib.request, urllib.error, urllib.parse, uuid
import smtplib, ssl
from email.message import EmailMessage
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
import re

# ─── ثوابت ─────────────────────────────────────────────────────────────────
PORT      = int(os.environ.get('PORT', 5000))
WWW_DIR   = os.path.join(os.path.dirname(__file__), 'www')
HTML_FILE = os.path.join(WWW_DIR, 'index.html')
QUESTION_IMAGE_DIR = os.path.join(
    os.path.dirname(__file__), 'server-assets', 'question-images')
QUESTION_BANK_DIR = os.path.join(
    os.path.dirname(__file__), 'server-assets', 'question-bank', 'v1')
QUESTION_BANK_FILE = os.path.join(QUESTION_BANK_DIR, 'bank.json')
DB_PATH   = os.path.join(os.path.dirname(__file__), 'subscriptions.db')
IOS_DIAGNOSTIC_RETENTION_DAYS = 30
QUESTION_IMAGE_ALLOWED_ORIGINS = frozenset({
    'capacitor://localhost',
    'ionic://localhost',
    'https://fatinah-next-1-3-security-review.replit.app',
})


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

_question_bank_cache = {'mtime_ns': None, 'document': None}
_question_bank_cache_lock = threading.Lock()
ISLAMIC_REMOTE_SOURCE_CATEGORIES = (
    'السيرة النبوية', 'فتوحات المسلمين', 'القرآن الكريم', 'الصحابة',
    'الخلفاء الراشدون', 'دين وسيرة', 'الأنبياء والرسل',
)


def load_server_question_bank():
    """اقرأ نسخة البنك المنشورة فقط وتحقق من بصمتها قبل تقديم أي سؤال."""
    stat = os.stat(QUESTION_BANK_FILE)
    with _question_bank_cache_lock:
        if (_question_bank_cache['document'] is not None and
                _question_bank_cache['mtime_ns'] == stat.st_mtime_ns):
            return _question_bank_cache['document']
        if stat.st_size > 50 * 1024 * 1024:
            raise ValueError('ملف بنك الأسئلة يتجاوز 50MB')
        with open(QUESTION_BANK_FILE, 'r', encoding='utf-8') as bank_file:
            document = json.load(bank_file)
        if (not isinstance(document, dict) or document.get('schemaVersion') != 1 or
                not isinstance(document.get('categories'), dict)):
            raise ValueError('مخطط بنك الأسئلة غير صالح')
        categories = document['categories']
        questions = []
        for category, rows in categories.items():
            if (not isinstance(category, str) or not category.strip() or
                    not isinstance(rows, list)):
                raise ValueError('فئة غير صالحة في بنك الأسئلة')
            questions.extend(rows)
        question_count = document.get('questionCount')
        target_bank_size = document.get('targetBankSize')
        if (not isinstance(question_count, int) or isinstance(question_count, bool) or
                question_count != len(questions)):
            raise ValueError('عدد أسئلة البنك لا يطابق المحتوى')
        if (not isinstance(target_bank_size, int) or isinstance(target_bank_size, bool) or
                target_bank_size < 1 or target_bank_size > 100_000):
            raise ValueError('هدف بنك الأسئلة غير صالح')
        expected_ready = question_count == target_bank_size
        if document.get('ready') is not expected_ready:
            raise ValueError('حالة جاهزية بنك الأسئلة لا تطابق عدده')
        seen_ids = set()
        for question in questions:
            if (not isinstance(question, dict) or
                    not re.fullmatch(r'gq-[a-f0-9]{20}', str(question.get('id') or '')) or
                    question['id'] in seen_ids or
                    question.get('d') not in range(1, 7) or
                    not isinstance(question.get('q'), str) or
                    not 12 <= len(question['q'].strip()) <= 220 or
                    not isinstance(question.get('answer'), str) or
                    not 1 <= len(question['answer'].strip()) <= 140 or
                    question.get('review', {}).get('status') != 'approved'):
                raise ValueError('سجل غير صالح في بنك الأسئلة')
            source_url = str(question.get('source', {}).get('url') or '')
            if not source_url.startswith('https://'):
                raise ValueError('مصدر سؤال غير آمن في بنك الأسئلة')
            seen_ids.add(question['id'])
        canonical = json.dumps(
            categories, ensure_ascii=False,
            separators=(',', ':')).encode('utf-8')
        digest = hashlib.sha256(canonical).hexdigest()
        if not secrets.compare_digest(digest, str(document.get('sha256') or '')):
            raise ValueError('بصمة بنك الأسئلة لا تطابق المحتوى')
        _question_bank_cache.update(mtime_ns=stat.st_mtime_ns, document=document)
        return document


def select_remote_round_questions(request_data: dict):
    """اختر سؤالاً واحداً لكل مستوى وفئة، ولا تبدأ جولة ناقصة."""
    categories = request_data.get('categories')
    excluded = request_data.get('excludeQuestionIds', [])
    if (not isinstance(categories, list) or not 1 <= len(categories) <= 8 or
            any(not isinstance(item, str) or not 1 <= len(item.strip()) <= 80
                for item in categories) or len(set(categories)) != len(categories)):
        return 400, {'error': 'الفئات غير صالحة', 'code': 'invalid_categories'}
    if (not isinstance(excluded, list) or len(excluded) > 2000 or
            any(not isinstance(item, str) or len(item) > 128 for item in excluded)):
        return 400, {'error': 'قائمة الأسئلة السابقة غير صالحة', 'code': 'invalid_exclusions'}
    document = load_server_question_bank()
    if document.get('ready') is not True:
        return 503, {
            'error': 'بنك الأسئلة الجديد لم يكتمل بعد',
            'code': 'question_bank_not_ready',
            'questionCount': int(document.get('questionCount') or 0),
            'targetBankSize': int(document.get('targetBankSize') or 4000),
        }
    bank = document['categories']
    excluded_ids = set(excluded)
    selected = {}
    missing = []
    for raw_category in categories:
        category = raw_category.strip()
        source_categories = (ISLAMIC_REMOTE_SOURCE_CATEGORIES
                             if category == 'إسلاميات' else (category,))
        rows = []
        for source_category in source_categories:
            source_rows = bank.get(source_category, [])
            if isinstance(source_rows, list):
                rows.extend(source_rows)
        chosen = []
        for level in range(1, 7):
            candidates = [row for row in rows
                          if isinstance(row, dict) and row.get('d') == level
                          and isinstance(row.get('id'), str)
                          and row['id'] not in excluded_ids
                          and isinstance(row.get('q'), str) and row['q'].strip()
                          and isinstance(row.get('answer'), str) and row['answer'].strip()
                          and row.get('review', {}).get('status') == 'approved']
            if not candidates:
                missing.append({'category': category, 'difficulty': level})
                continue
            question = secrets.choice(candidates)
            excluded_ids.add(question['id'])
            chosen.append(question)
        selected[category] = chosen
    if missing:
        return 409, {
            'error': 'بنك الجولة لا يحتوي أسئلة جديدة كافية',
            'code': 'question_pool_incomplete',
            'missing': missing,
            'bankVersion': document.get('bankVersion'),
        }
    return 200, {
        'schemaVersion': 1,
        'bankVersion': document.get('bankVersion'),
        'questions': selected,
    }

def safe_log_reference(value) -> str:
    """بصمة قصيرة للسجلات؛ لا تطبع UID أو App User ID أو report ID خاماً."""
    text = str(value or '')
    if not text:
        return 'none'
    return hashlib.sha256(text.encode('utf-8')).hexdigest()[:12]

def exception_kind(exc: BaseException) -> str:
    """نوع ثابت قابل للتشخيص من دون message قد تحمل بيانات مستخدم/اعتماد."""
    return type(exc).__name__

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
            source_title  TEXT,
            source_url    TEXT,
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
    for ddl in (
        "ALTER TABLE question_reports ADD COLUMN source_title TEXT",
        "ALTER TABLE question_reports ADD COLUMN source_url TEXT",
    ):
        try: conn.execute(ddl)
        except sqlite3.OperationalError: pass
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
PRODUCTION_GENERATION_HOSTS = {
    'us-central1-fatinah-game.cloudfunctions.net',
}
LEGACY_GENERATION_TIMEOUT_SECONDS = 42
LEGACY_GENERATION_ALLOWED_HOSTS_ENV = 'FATINAH_V1_GENERATION_ALLOWED_HOSTS'


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
    '/api/generate': None,  # tombstone v2؛ لا يصل إلى AI
    '/api/app-attest/status': 'app_attest',
    '/api/app-attest/challenge': 'app_attest',
    '/api/app-attest/attest': 'app_attest',
    '/api/free-round/status': 'free_round',
    '/api/free-round/complete': 'free_round',
    '/api/questions/seen': 'question_history',
    '/api/questions/round': 'question_bank',
    '/api/questions/report': 'question_reports',
    '/api/metrics/event': 'metrics',
    '/api/ios-diagnostics': 'ios_diagnostics',
    '/api/revenuecat/webhook': 'revenuecat_webhook',
}

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
    '/api/questions/seen',
    '/api/questions/round',
    '/api/questions/report',
    '/api/metrics/event',
}


def v2_feature_enabled(feature: str) -> bool:
    """أعلام v2 صريحة في الإنتاج، ومفعلة افتراضياً محلياً وفي staging."""
    env_name = f'FATINAH_V2_FEATURE_{feature.upper()}_ENABLED'
    default = deployment_environment() in {'local', 'staging'}
    return env_flag(env_name, default)


def legacy_v1_generation_enabled() -> bool:
    # Opt-in صريح: نشر الكود بلا إعداد مكتمل لا يفعّل تكلفة AI بالخطأ.
    # لاستمرار 1.2 يجب ضبط القيمة true في بيئة production قبل النشر.
    return env_flag('FATINAH_V1_AI_GENERATION_ENABLED', False)


APP_CHECK_PROTECTED_PATHS = {
    '/api/account/delete', '/api/account/profile',
    '/api/app-attest/status', '/api/app-attest/challenge',
    '/api/app-attest/attest',
    '/api/free-round/complete', '/api/free-round/status',
    '/api/questions/seen', '/api/questions/round', '/api/questions/report',
    '/api/metrics/event', '/api/ios-diagnostics',
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
     source_title, source_url, reason, details, app_version, _created_at) = row
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
    if not use_ssl and not use_tls and (
            username or deployment_environment() == 'production'):
        # لا نسمح بإرسال البلاغات أو بيانات اعتماد SMTP بنص صريح. نبقي
        # الرسالة pending_configuration لتُرسل تلقائياً بعد تصحيح الإعداد.
        return 'pending_configuration'

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
        f'عنوان المصدر: {source_title or "—"}\n'
        f'رابط المصدر: {source_url or "—"}\n'
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
                   answer_text, source_title, source_url, reason, details,
                   app_version, created_at
            FROM question_reports
            WHERE email_status IN ('pending','failed','pending_configuration')
              AND (email_status='pending_configuration' OR email_attempts < 20)
            ORDER BY created_at LIMIT ?
        ''', (limit,)).fetchall()
        for row in rows:
            try:
                status = _send_question_report_email(row)
                conn.execute('''
                    UPDATE question_reports
                    SET email_status=?, email_error=NULL,
                        email_attempts=email_attempts +
                            CASE WHEN ?='pending_configuration' THEN 0 ELSE 1 END,
                        emailed_at=CASE WHEN ?='sent' THEN CURRENT_TIMESTAMP ELSE emailed_at END
                    WHERE report_id=?
                ''', (status, status, status, row[0]))
                status_updates.append((row[0], status, None))
                delivered += int(status == 'sent')
            except Exception as exc:
                error_kind = exception_kind(exc)
                conn.execute('''
                    UPDATE question_reports
                    SET email_status='failed', email_error=?,
                        email_attempts=email_attempts+1
                    WHERE report_id=?
                ''', (error_kind, row[0]))
                status_updates.append((row[0], 'failed', error_kind))
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
                print('[Question Reports] Firestore status sync failed '
                      f'ref={safe_log_reference(report_id)}: {exception_kind(exc)}')
    return delivered

def _question_report_email_worker():
    while True:
        time.sleep(60)
        try: deliver_pending_question_reports()
        except Exception as exc:
            print(f'[Question Reports] retry error: {exception_kind(exc)}')
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

def durable_write(document_path: str, data: dict, *, merge: bool = True) -> bool:
    """اكتب إلى المخزن الدائم أو ارفع خطأ في النشر ذي التخزين الإلزامي."""
    if firestore_durable_available():
        firestore_set_document(document_path, data, merge=merge)
        return True
    if durable_storage_required():
        raise RuntimeError('التخزين الدائم مطلوب لكن بيانات اعتماد Firestore غير مكتملة')
    return False


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
    """ثبّت ملكية الجولة دائماً قبل تحديث الكاش المحلي."""
    durable_write(f'free_rounds/{uid}', {
        'uid': uid,
        'completed': True,
        'completed_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    })
    conn = db_connect()
    try:
        conn.execute(
            'INSERT OR IGNORE INTO free_rounds (uid) VALUES (?)', (uid,))
        conn.commit()
    finally:
        conn.close()


# ─── App Attest: تحديات قصيرة ومفاتيح تثبيت موثقة ───────────────────────────
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
    rc_app_user_id = (reverse_identity or {}).get('rc_app_user_id')

    # Firestore لا يحذف المجموعات الفرعية عند حذف الوثيقة الأب؛ لذلك نحذفها
    # صراحةً قبل وثائق المستوى الأعلى.
    for subcollection in ('question_seen', 'game_events', 'ios_diagnostics'):
        for document in firestore_list_documents(f'users/{uid}/{subcollection}'):
            firestore_delete_document(
                f'users/{uid}/{subcollection}/{document["_document_id"]}')

    for report in firestore_query_documents('question_reports', 'uid', uid):
        firestore_delete_document(f'question_reports/{report["_document_id"]}')

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
            print('[RevenueCat] replay failed '
                  f'event_ref={safe_log_reference(document.get("event_id"))}: '
                  f'{exception_kind(exc)}')
    return replayed

# ─── قراءة index.html ────────────────────────────────────────────────────────
def read_html():
    with open(HTML_FILE, 'rb') as f:
        return f.read()


def production_landing_html() -> bytes:
    """صفحة عامة آمنة؛ تطبيق اللعبة نفسه موزع داخل حزمة iOS فقط.

    منطق الاشتراك والأسئلة الموجود في JavaScript ليس حاجز صلاحيات صالحًا
    لمتصفح عام. لذلك لا نخدم حزمة اللعبة من خادم production، ونبقي الموقع
    العام مقتصرًا على تعريف التطبيق وروابط Apple والوثائق القانونية.
    """
    return b'''<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>\xd9\x81\xd8\xb7\xd9\x86\xd8\xa9</title>
  <style>
    :root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#10091f;color:#fff}
    main{max-width:42rem;margin:2rem;padding:2.5rem;border:1px solid #ffffff29;border-radius:1.5rem;
      text-align:center;background:linear-gradient(145deg,#24102f,#10091f)}
    h1{font-size:3rem;margin:.25rem} p{line-height:1.8;color:#d9cfe7}
    a{color:#fff} .store{display:inline-block;margin:1rem;padding:.9rem 1.25rem;border-radius:999px;
      background:#ff356d;text-decoration:none;font-weight:700}
    nav{display:flex;gap:1rem;justify-content:center;flex-wrap:wrap;margin-top:1.5rem}
  </style>
</head>
<body><main>
  <h1>\xd9\x81\xd8\xb7\xd9\x86\xd8\xa9</h1>
  <p>\xd9\x84\xd8\xb9\xd8\xa8\xd8\xa9 \xd8\xa7\xd9\x84\xd8\xb0\xd9\x83\xd8\xa7\xd8\xa1 \xd9\x88\xd8\xa7\xd9\x84\xd9\x81\xd8\xb7\xd9\x86\xd8\xa9 \xd8\xa7\xd9\x84\xd8\xac\xd9\x85\xd8\xa7\xd8\xb9\xd9\x8a\xd8\xa9. \xd8\xad\xd9\x85\xd9\x91\xd9\x84 \xd8\xa7\xd9\x84\xd8\xaa\xd8\xb7\xd8\xa8\xd9\x8a\xd9\x82 \xd8\xa7\xd9\x84\xd8\xb1\xd8\xb3\xd9\x85\xd9\x8a \xd9\x85\xd9\x86 App Store.</p>
  <a class="store" href="https://apps.apple.com/app/id6794660419" rel="noopener">App Store</a>
  <nav><a href="/privacy-policy.html">\xd8\xb3\xd9\x8a\xd8\xa7\xd8\xb3\xd8\xa9 \xd8\xa7\xd9\x84\xd8\xae\xd8\xb5\xd9\x88\xd8\xb5\xd9\x8a\xd8\xa9</a><a href="/terms-of-service.html">\xd8\xb4\xd8\xb1\xd9\x88\xd8\xb7 \xd8\xa7\xd9\x84\xd8\xa7\xd8\xb3\xd8\xaa\xd8\xae\xd8\xaf\xd8\xa7\xd9\x85</a></nav>
</main></body></html>'''

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


# تطبيق 1.2 يستعمل اسم الدالة القديم مباشرة على iOS، كما يستعمل هذا المسار
# عند التشغيل على الويب/localhost. نبقي العقد نفسه طوال نافذة التوافق، بينما
# يظل التوليد خارج server.py حتى لا تتكرر أسرار الذكاء الاصطناعي أو منطقها.
LEGACY_V1_GENERATION_URL = (
    'https://us-central1-fatinah-game.cloudfunctions.net/generateQuestions'
)


def legacy_v1_generation_url() -> str:
    configured = os.environ.get('FATINAH_V1_GENERATION_URL', '').strip()
    if configured:
        return configured
    # staging/local لا يستدعيان production ضمنياً. في الإنتاج نحافظ على
    # الوجهة التاريخية لتطبيق 1.2 ما لم تُضبط وجهة صريحة.
    return (
        LEGACY_V1_GENERATION_URL
        if configured_deployment_environment() == 'production'
        else ''
    )


def _configured_host_allowlist(name: str) -> set[str]:
    hosts = set()
    for raw in os.environ.get(name, '').split(','):
        host = raw.strip().lower().rstrip('.')
        if host and re.fullmatch(r'[a-z0-9.-]{1,253}', host):
            hosts.add(host)
    return hosts


def _legacy_generation_allowed_hosts() -> set[str]:
    environment = configured_deployment_environment()
    if environment == 'production':
        return set(PRODUCTION_GENERATION_HOSTS)
    configured = _configured_host_allowlist(LEGACY_GENERATION_ALLOWED_HOSTS_ENV)
    if environment == 'staging':
        return configured
    if environment == 'local':
        return configured | {'127.0.0.1', '::1', 'localhost'}
    return set()


def _hostname_resolves_to_public_ips(hostname: str, port: int) -> bool:
    try:
        literal = ipaddress.ip_address(hostname)
    except ValueError:
        literal = None
    if literal is not None:
        return literal.is_global
    try:
        addresses = socket.getaddrinfo(
            hostname, port, type=socket.SOCK_STREAM)
    except (OSError, socket.gaierror):
        return False
    resolved = set()
    for address in addresses:
        try:
            resolved.add(ipaddress.ip_address(address[4][0]))
        except (ValueError, IndexError):
            return False
    return bool(resolved) and all(address.is_global for address in resolved)


def _legacy_generation_endpoint_is_safe(url: str) -> bool:
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return False
    hostname = (parsed.hostname or '').lower().rstrip('.')
    if parsed.username or parsed.password or parsed.fragment:
        return False
    environment = configured_deployment_environment()
    if hostname not in _legacy_generation_allowed_hosts():
        return False
    try:
        port = parsed.port or (443 if parsed.scheme == 'https' else 80)
    except ValueError:
        return False
    local_http = (
        environment == 'local'
        and parsed.scheme == 'http'
        and hostname in {'127.0.0.1', '::1', 'localhost'}
    )
    if not local_http:
        if parsed.scheme != 'https' or port != 443:
            return False
        if not _hostname_resolves_to_public_ips(hostname, port):
            return False
    if environment == 'production':
        return parsed.path == '/generateQuestions' and not parsed.query
    return True


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _open_legacy_generation_request(request, timeout: int):
    opener = urllib.request.build_opener(_NoRedirectHandler())
    return opener.open(request, timeout=timeout)


def _sanitized_legacy_generation_response(status: int, result: dict,
                                          count: int) -> tuple[int, dict]:
    """لا يمرر حقول upstream عمياءً كي لا تتسرب بيانات تشخيصية أو أسرار."""
    if 200 <= status < 300:
        questions = result.get('questions')
        if not isinstance(questions, list):
            return 502, {'error': 'استجابة خدمة التوليد غير صالحة'}
        safe_questions = []
        for question in questions[:count]:
            if not isinstance(question, dict):
                continue
            q = str(question.get('q') or '').strip()[:600]
            answer = str(question.get('answer') or '').strip()[:400]
            if not q or not answer:
                continue
            clean = {'q': q, 'answer': answer}
            question_id = question.get('id')
            if isinstance(question_id, (str, int)) and not isinstance(question_id, bool):
                clean['id'] = str(question_id)[:160]
            source = question.get('source')
            if isinstance(source, dict):
                source_url = str(source.get('url') or '').strip()[:2048]
                try:
                    parsed_source = urllib.parse.urlparse(source_url)
                except ValueError:
                    parsed_source = None
                if parsed_source and parsed_source.scheme == 'https' and parsed_source.hostname:
                    clean['source'] = {
                        'title': str(source.get('title') or 'مرجع موثوق').strip()[:120],
                        'url': source_url,
                    }
            safe_questions.append(clean)
        return status, {
            'questions': safe_questions,
            'trustedSources': result.get('trustedSources') is True,
        }

    safe_status = status if 400 <= status <= 599 else 502
    message = str(result.get('error') or 'تعذّر التوليد، حاول لاحقاً').strip()[:300]
    payload = {'error': message or 'تعذّر التوليد، حاول لاحقاً'}
    code = result.get('code')
    if isinstance(code, str) and re.fullmatch(r'[a-z0-9_]{1,64}', code):
        payload['code'] = code
    return safe_status, payload


def legacy_generate_questions(data: dict) -> tuple[int, dict]:
    """يمرر عقد v1 القديم بعد التحقق محلياً؛ لا يعيد 410 أثناء الدعم."""
    if not legacy_v1_generation_enabled():
        return 503, {
            'error': 'التوليد القديم غير متاح مؤقتاً',
            'code': 'legacy_feature_disabled',
        }
    if not isinstance(data, dict):
        return 400, {'error': 'JSON غير صالح'}

    uid = str(data.get('uid') or '').strip()
    id_token = str(data.get('idToken') or '').strip()
    topic = str(data.get('topic') or '').strip()[:200]
    try:
        count = int(data.get('count') or 6)
    except (TypeError, ValueError):
        return 400, {'error': 'count غير صالح'}
    count = max(4, min(12, count))
    if not uid or not id_token:
        return 401, {'error': 'رمز الدخول مطلوب'}
    if not topic:
        return 400, {'error': 'topic مطلوب'}
    if not uid_matches_token(uid, id_token):
        return 401, {'error': 'رمز الدخول غير صالح — سجّل دخولك مرة أخرى'}
    # حد أولي بعد إثبات الهوية وقبل أي شبكة. trustedRound قيمة عميل ولا تمنح
    # حصة أعلى؛ الحد واحد لكل مستخدمي عقد 1.2.
    if rate_limited(f'legacy-ai:{uid}', 10, 600):
        return 429, {'error': 'طلبات كثيرة جداً — حاول بعد قليل'}
    if not subscription_is_active(uid):
        return 403, {'error': 'اشتراك فعّال مطلوب'}

    trusted_round = data.get('trustedRound') is True

    seen = data.get('seen') or []
    if not isinstance(seen, list):
        return 400, {'error': 'seen غير صالح'}
    safe_seen = []
    for item in seen[-5000:]:
        if isinstance(item, (str, int)) and not isinstance(item, bool):
            safe_seen.append(str(item)[:160])

    endpoint = legacy_v1_generation_url()
    if not _legacy_generation_endpoint_is_safe(endpoint):
        return 503, {
            'error': 'إعداد خدمة التوليد القديم غير صالح',
            'code': 'legacy_backend_misconfigured',
        }

    payload = json.dumps({
        'topic': topic,
        'count': count,
        'seen': safe_seen,
        'uid': uid,
        'idToken': id_token,
        'trustedRound': trusted_round,
    }, ensure_ascii=False).encode()
    request = urllib.request.Request(
        endpoint,
        data=payload,
        method='POST',
        headers={
            'Content-Type': 'application/json; charset=utf-8',
            API_VERSION_HEADER: '1',
        },
    )
    try:
        with _open_legacy_generation_request(
                request, timeout=LEGACY_GENERATION_TIMEOUT_SECONDS) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
            status = response.status
    except urllib.error.HTTPError as exc:
        status = exc.code
        raw = exc.read(64 * 1024)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        print(f'[Legacy AI v1] upstream unavailable: {type(exc).__name__}')
        return 502, {'error': 'تعذّر التوليد، حاول لاحقاً'}

    if len(raw) > 2 * 1024 * 1024:
        return 502, {'error': 'استجابة خدمة التوليد أكبر من الحد المسموح'}
    try:
        result = json.loads(raw or b'{}')
    except (json.JSONDecodeError, UnicodeDecodeError):
        return 502, {'error': 'استجابة خدمة التوليد غير صالحة'}
    if not isinstance(result, dict):
        return 502, {'error': 'استجابة خدمة التوليد غير صالحة'}
    return _sanitized_legacy_generation_response(status, result, count)

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
<p><b>آخر تحديث: 21 أغسطس 2026</b></p>
<p>باستخدامك تطبيق <b>فطنة</b> فأنت توافق على هذه الشروط.</p>
<p><b>الاشتراك:</b><br>
• يعرض App Store السعر الشهري والسنوي بعملتك المحلية قبل تأكيد الشراء<br>
• يتجدد الاشتراك تلقائياً ما لم يُلغَ قبل 24 ساعة من انتهاء الفترة الحالية<br>
• يمكن إلغاؤه في أي وقت من إعدادات Apple ID</p>
<p><b>الاستخدام المقبول:</b><br>
التطبيق للاستخدام الشخصي والترفيهي. يُحظر نسخ المحتوى أو إعادة توزيعه.</p>
<p><b>الملكية الفكرية:</b><br>
جميع محتويات التطبيق محمية بحقوق النشر لصالح مطوّر فطنة.</p>
<p><b>إخلاء المسؤولية:</b><br>
التطبيق مقدَّم "كما هو" بدون ضمانات. المطوّر غير مسؤول عن أي أضرار ناجمة عن الاستخدام.</p>
<p><b>التواصل:</b><br>
fatinahgame@gmail.com</p>
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

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type',   'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Expose-Headers',
                         f'{API_VERSION_HEADER}, X-Fatinah-Environment')
        self.send_header(API_VERSION_HEADER, getattr(self, '_api_version', '1'))
        self.send_header('X-Fatinah-Environment', deployment_environment())
        self.send_header('Vary', API_VERSION_HEADER)
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

        # أزيلت أكواد التفعيل الخاصة امتثالاً لسياسة مشتريات Apple. أي عروض
        # ترويجية يجب أن تمر عبر StoreKit Offer Codes فقط.
        if path == '/admin/promo' or path.startswith('/api/promo/'):
            self.send_json(410, {'error': 'تم إيقاف أكواد التفعيل الخاصة؛ استخدم Apple Offer Codes'}); return

        if path == '/api/version':
            self.send_json(200, {
                'apiVersion': self._api_version,
                'environment': deployment_environment(),
                'unversionedDefault': '1',
                'supportedVersions': ['1', '2'],
                'features': (
                    {name: v2_feature_enabled(name)
                     for name in sorted({value for value in V2_ROUTE_FEATURES.values()
                                         if value is not None})}
                    if self._api_version == '2'
                    else {'legacyAiGeneration': legacy_v1_generation_enabled()}
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
                    print('[Question Seen] Firestore read failed '
                          f'uid_ref={safe_log_reference(uid)}: {exception_kind(exc)}')
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

        elif path.startswith('/assets/question-images/'):
            relative_path = path[len('/assets/question-images/'):]
            image_root = os.path.realpath(QUESTION_IMAGE_DIR)
            full_path = os.path.realpath(os.path.join(image_root, relative_path))
            extension = os.path.splitext(full_path)[1].lower()
            if (not relative_path or not full_path.startswith(image_root + os.sep)
                    or extension not in ('.avif', '.webp')):
                self.send_response(404); self.end_headers(); return
            content_type = ('image/avif' if extension == '.avif' else 'image/webp')
            try:
                with open(full_path, 'rb') as image_file:
                    body = image_file.read()
                origin = (self.headers.get('Origin') or '').strip()
                image_headers = {'Cross-Origin-Resource-Policy': 'same-site'}
                if origin in QUESTION_IMAGE_ALLOWED_ORIGINS:
                    image_headers.update({
                        'Access-Control-Allow-Origin': origin,
                        'Access-Control-Expose-Headers': 'ETag',
                        'Cross-Origin-Resource-Policy': 'cross-origin',
                        'Vary': 'Origin',
                    })
                self.send_asset(
                    body, content_type,
                    'public, max-age=31536000, immutable', compress=False,
                    extra_headers=image_headers)
            except FileNotFoundError:
                self.send_response(404); self.end_headers()

        elif path in ('/', '/index.html'):
            # حزمة iOS تحمل ملفات اللعبة محلياً. تقديمها على الويب في
            # production يجعل Boolean داخل JavaScript هو حاجز الاشتراك، وهو
            # قابل للتعديل من DevTools. الموقع العام يعرض صفحة تعريف فقط.
            body = (read_html() if public_web_game_enabled()
                    else production_landing_html())
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
                      '/image-question-bank.js', '/image-question-bank-commons.js',
                      '/privacy-policy.html', '/terms-of-service.html'):
            fname = path.lstrip('/')
            game_assets = {
                'app.js', 'app.css', 'question-bank.js',
                'approved-question-bank.js', 'image-question-bank.js',
                'image-question-bank-commons.js',
            }
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
        '/api/generate':                1_024,   # v2 متوقف؛ يرفع max_body_for سقف v1
        '/api/account/delete':          4_096,   # 4 KB   (uid + idToken)
        '/api/revenuecat/webhook':     65_536,   # 64 KB  (حدث RevenueCat)
        '/api/revenuecat/identity':     2_048,   # uid + UUID + token
        '/api/account/profile':         2_048,   # 2 KB   (name + email + provider)
        '/api/app-attest/challenge':     4_096,
        '/api/app-attest/attest':      262_144,  # CBOR x5c + receipt بصيغة Base64
        '/api/questions/seen':          32_768,  # حتى 100 معرّف في دفعة مزامنة
        '/api/questions/round':         262_144, # فئات الجولة ومعرّفات الأسئلة السابقة
        '/api/free-round/complete':     64_000,  # DeviceCheck + App Attest assertion
        '/api/questions/report':         8_192,
        '/api/metrics/event':            4_096,
        '/api/ios-diagnostics':        655_360,
    }
    _DEFAULT_MAX_BODY = 16_384  # 16 KB للمسارات غير المدرجة

    def max_body_for(self, path: str) -> int:
        # تطبيق 1.2 قد يرسل قائمة seen كبيرة. نبقي سقفاً محكوماً ومتوافقاً،
        # فيما يظل v2 المتوقف صغيراً ولا يقرأ حمولة غير لازمة.
        if path == '/api/generate' and self._api_version == '1':
            return 256 * 1024
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
        # الوصول خاص بمشترك مسجّل ومتحقق الهوية. الجولة المجانية تستخدم البنك
        # المحلي المحدود، فلا يتحول هذا المسار إلى منفذ عام لاستخراج المحتوى.
        if path == '/api/questions/round':
            if self._api_version != '2':
                self.send_json(404, {
                    'error': 'بنك الجولات متاح في عقد API v2 فقط',
                    'code': 'question_bank_v2_only',
                }); return
            try:
                data = json.loads(body)
            except Exception:
                self.send_json(400, {'error': 'JSON غير صالح'}); return
            if not isinstance(data, dict):
                self.send_json(400, {'error': 'JSON غير صالح'}); return
            uid = str(data.get('uid') or '').strip()
            id_token = str(data.get('idToken') or bearer_token(self.headers) or '').strip()
            if not uid or not uid_matches_token(uid, id_token):
                self.send_json(401, {
                    'error': 'رمز الدخول غير صالح — سجّل دخولك مرة أخرى',
                    'code': 'question_bank_auth_required',
                }); return
            if not subscription_is_active(uid):
                self.send_json(403, {
                    'error': 'بنك الجولات الموسع متاح للمشتركين فقط',
                    'code': 'subscription_required',
                }); return
            if rate_limited(f'question-round:{safe_log_reference(uid)}', 30, 600):
                self.send_json(429, {'error': 'طلبات كثيرة جداً — حاول بعد قليل'}); return
            try:
                status, result = select_remote_round_questions(data)
            except (FileNotFoundError, ValueError, OSError) as exc:
                print(f'[Question Bank] unavailable: {exception_kind(exc)}')
                self.send_json(503, {
                    'error': 'بنك الأسئلة غير متاح مؤقتاً',
                    'code': 'question_bank_unavailable',
                }); return
            self.send_json(status, result); return

        # ─── عقد التوليد: v1 متوافق، وv2 متوقف صراحةً ───────────────────────
        if path == '/api/generate':
            if self._api_version == '2':
                self.send_json(410, {
                    'error': 'يستخدم API v2 بنك أسئلة مراجعاً مسبقاً.',
                    'code': 'ai_generation_retired',
                }); return
            try:
                data = json.loads(body)
            except Exception:
                self.send_json(400, {'error': 'JSON غير صالح'}); return
            status, result = legacy_generate_questions(data)
            self.send_json(status, result); return

        elif path == '/api/free-round/complete':
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

        elif path == '/api/questions/report':
            try: data = json.loads(body)
            except Exception: self.send_json(400, {'error': 'JSON غير صالح'}); return
            uid = str(data.get('uid') or '').strip()
            id_token = str(data.get('idToken') or bearer_token(self.headers) or '').strip()
            question_id = str(data.get('questionId') or '').strip()
            category = str(data.get('category') or '').strip()
            question_text = str(data.get('question') or '').strip()
            answer_text = str(data.get('answer') or '').strip()
            source_title = str(data.get('sourceTitle') or '').strip()
            source_url = str(data.get('sourceUrl') or '').strip()
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
                    or len(source_title) > 240
                    or any(ord(char) < 32 for char in source_title)
                    or len(source_url) > 2048
                    or (source_url and (
                        urllib.parse.urlparse(source_url).scheme != 'https'
                        or not urllib.parse.urlparse(source_url).hostname
                        or urllib.parse.urlparse(source_url).username is not None
                        or urllib.parse.urlparse(source_url).password is not None
                    ))
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
                'source_title': source_title,
                'source_url': source_url,
                'reason': reason,
                'details': details,
                'app_version': app_version,
                'email_status': 'pending',
                'created_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            }
            try:
                durable_write(f'question_reports/{report_id}', report_record, merge=False)
            except Exception as exc:
                print('[Question Report] durable write failed '
                      f'report_ref={safe_log_reference(report_id)}: '
                      f'{exception_kind(exc)}')
                self.send_json(503, {'error': 'تعذّر حفظ البلاغ بأمان — حاول مرة أخرى'}); return
            conn = db_connect()
            try:
                conn.execute('''
                    INSERT INTO question_reports
                    (report_id, uid, question_id, category, question_text,
                     answer_text, source_title, source_url, reason, details,
                     app_version)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)
                ''', (report_id, uid, question_id, category, question_text,
                      answer_text, source_title, source_url, reason, details,
                      app_version))
                conn.commit()
            finally:
                conn.close()
            # الحفظ هو نقطة النجاح؛ فشل البريد لا يعيد الطلب ولا يفقد البلاغ.
            try:
                deliver_pending_question_reports(limit=5)
            except Exception as exc:
                print('[Question Reports] immediate delivery error: '
                      f'{exception_kind(exc)}')
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
                    print('[Question Report] email state sync failed '
                          f'report_ref={safe_log_reference(report_id)}: '
                          f'{exception_kind(exc)}')
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
                    print('[Question Seen] durable batch failed '
                          f'uid_ref={safe_log_reference(uid)}: {exception_kind(exc)}')
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

            uid      = (data.get('uid')     or '').strip()
            name     = (data.get('name')    or '').strip()[:60]
            email    = (data.get('email')   or '').strip()[:200]
            provider = (data.get('provider') or '').strip()[:30]
            id_token = (data.get('idToken') or '').strip()
            if not uid: self.send_json(400, {'error': 'uid مطلوب'}); return

            if not uid_matches_token(uid, id_token):
                self.send_json(401, {'error': 'رمز الدخول غير صالح — سجّل دخولك مرة أخرى'}); return
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

            uid = (data.get('uid') or '').strip()
            rc_app_user_id = (data.get('rcAppUserId') or '').strip().lower()
            id_token = (data.get('idToken') or '').strip()
            if not uid or not is_valid_rc_app_user_id(rc_app_user_id):
                self.send_json(400, {'error': 'UUID RevenueCat غير صالح'}); return
            if not uid_matches_token(uid, id_token):
                self.send_json(401, {'error': 'رمز الدخول غير صالح — سجّل دخولك مرة أخرى'}); return
            if rate_limited(f'revenuecat-identity:{uid}', 20, 600):
                self.send_json(429, {
                    'error': 'طلبات ربط كثيرة جداً — حاول لاحقاً'
                }); return

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
                    print('[RevenueCat] identity durable write failed '
                          f'uid_ref={safe_log_reference(uid)}: {exception_kind(exc)}')
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
                    print('[RevenueCat] pending replay failed '
                          f'rc_ref={safe_log_reference(rc_app_user_id)}: '
                          f'{exception_kind(exc)}')
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
                 answer_text, source_title, source_url, reason, details,
                 app_version, email_status, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            ''', (
                report_id,
                document.get('uid') or '',
                document.get('question_id') or '',
                document.get('category') or '',
                document.get('question_text') or '',
                document.get('answer_text') or '',
                document.get('source_title') or '',
                document.get('source_url') or '',
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
        print('[STARTUP] تعذّرت استعادة بلاغات البريد: '
              f'{exception_kind(exc)}')

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
