"""
خادم فَطِنة — Python stdlib فقط، بدون حزم خارجية (عدا stripe).
يخدم index.html، يوفّر firebase-config.js، يولّد الأسئلة عبر Claude،
ويدير اشتراكات Stripe.
"""
import json, os, sqlite3, urllib.request, urllib.error, urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

# ─── ثوابت ─────────────────────────────────────────────────────────────────
PORT      = int(os.environ.get('PORT', 5000))
HTML_FILE = os.path.join(os.path.dirname(__file__), 'index.html')
DB_PATH   = os.path.join(os.path.dirname(__file__), 'subscriptions.db')

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
    # ─── جداول أكواد المكافآت ───────────────────────────────────────────────
    conn.execute('''
        CREATE TABLE IF NOT EXISTS promo_codes (
            code       TEXT PRIMARY KEY,
            days       INTEGER NOT NULL DEFAULT 30,
            max_uses   INTEGER,
            used_count INTEGER NOT NULL DEFAULT 0,
            active     INTEGER NOT NULL DEFAULT 1,
            note       TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS promo_redemptions (
            uid          TEXT NOT NULL,
            code         TEXT NOT NULL,
            expires_at   DATETIME NOT NULL,
            redeemed_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (uid, code)
        )
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
    """يتحقق من صحة Firebase ID Token عبر Identity Toolkit، يعيد بيانات المستخدم أو None."""
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
    """يتحقق أن uid المطلوب هو نفس صاحب idToken المرسَل. يتجاوز التحقق إن كان
    Firebase غير مُعدّ أصلاً (بيئة بلا auth حقيقي)."""
    if not firebase_is_configured():
        return True
    verified = verify_firebase_id_token(id_token)
    return bool(verified and verified.get('localId') == uid)

# ─── Stripe credentials من Replit Connector ──────────────────────────────────
def get_stripe_keys():
    hostname      = os.environ.get('REPLIT_CONNECTORS_HOSTNAME', '')
    repl_identity = os.environ.get('REPL_IDENTITY', '')
    web_renewal   = os.environ.get('WEB_REPL_RENEWAL', '')

    if repl_identity:   token = f'repl {repl_identity}'
    elif web_renewal:   token = f'depl {web_renewal}'
    else:               return None, None

    if not hostname:    return None, None

    try:
        req = urllib.request.Request(
            f'https://{hostname}/api/v2/connection?include_secrets=true&connector_names=stripe',
            headers={'Accept': 'application/json', 'X-Replit-Token': token}
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        settings = (data.get('items') or [{}])[0].get('settings', {})
        return settings.get('secret') or settings.get('secret_key'), settings.get('webhook_secret')
    except Exception as e:
        print(f'Stripe credentials error: {e}')
        return None, None

# ─── Stripe API helper (urllib فقط) ─────────────────────────────────────────
def stripe_request(method, path, data=None, secret_key=None):
    """استدعاء Stripe REST API مباشرةً بدون مكتبة."""
    if not secret_key:
        secret_key, _ = get_stripe_keys()
    if not secret_key:
        raise Exception('Stripe key unavailable')

    url = f'https://api.stripe.com/v1/{path}'
    body = urllib.parse.urlencode(data).encode() if data else None
    import base64
    token = base64.b64encode(f'{secret_key}:'.encode()).decode()
    req = urllib.request.Request(url, data=body, method=method,
          headers={'Authorization': f'Basic {token}',
                   'Content-Type': 'application/x-www-form-urlencoded'})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())

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

# ─── Firestore REST upsert ───────────────────────────────────────────────────
def firestore_upsert_subscription(uid: str, status: str,
                                   stripe_customer_id: str = None,
                                   stripe_subscription_id: str = None) -> bool:
    """
    يحدّث (أو ينشئ) وثيقة Firestore في المسار subscriptions/{uid}.

    المصادقة (بالأولوية):
    1. FIREBASE_SERVICE_ACCOUNT_JSON (متغير بيئة يحتوي على JSON مفتاح الخدمة)
       → يُنشئ JWT موقَّع بـ RS256 ويستخدم Bearer token — آمن تماماً.
    2. إذا لم يُهيَّأ → يتخطى التحديث ويُعيد False مع تسجيل تحذير.

    يُعيد True عند النجاح، False عند الفشل (مع طباعة الخطأ).
    """
    import time as _time

    project_id = os.environ.get('FIREBASE_PROJECT_ID', '')
    sa_json_str = os.environ.get('FIREBASE_SERVICE_ACCOUNT_JSON', '')

    if not project_id:
        print('[Firestore] FIREBASE_PROJECT_ID غير متوفر — تخطى التحديث')
        return False
    if not sa_json_str:
        print('[Firestore] FIREBASE_SERVICE_ACCOUNT_JSON غير متوفر — '
              'أضف مفتاح الخدمة من Google Cloud Console لتفعيل تحديث Firestore')
        return False

    try:
        sa_json = json.loads(sa_json_str)
        token   = _get_gsa_access_token(sa_json)
    except Exception as exc:
        print(f'[Firestore] فشل الحصول على access token: {exc}')
        return False

    url = (
        f'https://firestore.googleapis.com/v1/projects/{project_id}'
        f'/databases/(default)/documents/subscriptions/{uid}'
    )

    # بناء الحقول بتنسيق Firestore REST (stringValue)
    fields = {
        'uid':        {'stringValue': uid},
        'status':     {'stringValue': status},
        'updated_at': {'stringValue': _time.strftime('%Y-%m-%dT%H:%M:%SZ', _time.gmtime())},
    }
    if stripe_customer_id:
        fields['stripe_customer_id'] = {'stringValue': stripe_customer_id}
    if stripe_subscription_id:
        fields['stripe_subscription_id'] = {'stringValue': stripe_subscription_id}

    payload = json.dumps({'fields': fields}).encode()
    req = urllib.request.Request(url, data=payload, method='PATCH',
          headers={
              'Content-Type':  'application/json',
              'Authorization': f'Bearer {token}',
          })
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
        return True
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors='ignore')
        print(f'[Firestore] HTTP {e.code}: {body[:300]}')
        return False
    except Exception as exc:
        print(f'[Firestore] خطأ: {exc}')
        return False

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

# ─── توليد الأسئلة عبر Claude ────────────────────────────────────────────────
def call_claude(topic: str, count: int):
    api_key = os.environ.get('ANTHROPIC_API_KEY', '')
    if not api_key:
        return None, 'ANTHROPIC_API_KEY غير موجود في البيئة'

    safe_count = min(max(int(count), 4), 30)
    prompt = (
        f'ولّد {safe_count} أسئلة مسابقات بالعربية بلهجة خليجية بسيطة عن: "{topic}".\n'
        'كل سؤال يجب أن يكون دقيقاً وصحيحاً واقعياً.\n'
        'أعد فقط مصفوفة JSON بالشكل: [{"q":"نص السؤال","answer":"الإجابة الصحيحة"}] '
        'بدون أي نص إضافي أو علامات markdown.'
    )

    payload = json.dumps({
        'model':      'claude-opus-4-5',
        'max_tokens': 4096,
        'messages':   [{'role': 'user', 'content': prompt}],
    }).encode()

    req = urllib.request.Request(
        'https://api.anthropic.com/v1/messages',
        data=payload,
        headers={
            'Content-Type':      'application/json',
            'x-api-key':         api_key,
            'anthropic-version': '2023-06-01',
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result     = json.loads(resp.read())
            text_block = next((b for b in result.get('content', []) if b.get('type') == 'text'), None)
            raw        = (text_block or {}).get('text', '[]')
            clean      = raw.replace('```json', '').replace('```', '').strip()
            questions  = json.loads(clean)
            valid      = [q for q in questions if q.get('q') and q.get('answer')] \
                         if isinstance(questions, list) else []
            return valid, None
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors='ignore')
        return None, f'Anthropic {e.code}: {body[:200]}'
    except Exception as exc:
        return None, str(exc)

# ─── صفحات قانونية عامة (لمتطلبات App Store Connect) ────────────────────────
PRIVACY_BODY = '''
<h1>سياسة الخصوصية</h1>
<p><b>آخر تحديث: يوليو 2025</b></p>
<p>تطبيق <b>فَطِنة</b> يحترم خصوصيتك ويلتزم بحمايتها.</p>
<p><b>البيانات التي نجمعها:</b><br>
• اسم اللاعب (اختياري — يُحفظ على جهازك فقط)<br>
• إحصاءات اللعب (نقاط، إنجازات — محلية على جهازك)<br>
• بريد إلكتروني عند التسجيل بـ Apple أو Google (لتفعيل الاشتراك فقط)</p>
<p><b>ما لا نجمعه:</b><br>
لا نبيع بياناتك. لا نتتبع موقعك. لا نشارك معلوماتك مع أطراف ثالثة إلا لأغراض معالجة الدفع (Stripe / Apple).</p>
<p><b>الاشتراكات:</b><br>
تُعالَج مدفوعات iOS عبر Apple App Store وتخضع لسياسة خصوصية Apple. لإلغاء الاشتراك: الإعدادات ← اسمك ← الاشتراكات.</p>
<p><b>التواصل:</b><br>
لأي استفسار: boturki13@gmail.com</p>
'''

TERMS_BODY = '''
<h1>شروط الاستخدام</h1>
<p><b>آخر تحديث: يوليو 2025</b></p>
<p>باستخدامك تطبيق <b>فَطِنة</b> فأنت توافق على هذه الشروط.</p>
<p><b>الاشتراك:</b><br>
• الاشتراك الشهري: $3.99 شهرياً<br>
• الاشتراك السنوي: $29.99 سنوياً<br>
• يتجدد الاشتراك تلقائياً ما لم يُلغَ قبل 24 ساعة من انتهاء الفترة الحالية<br>
• يمكن إلغاؤه في أي وقت من إعدادات Apple ID</p>
<p><b>الاستخدام المقبول:</b><br>
التطبيق للاستخدام الشخصي والترفيهي. يُحظر نسخ المحتوى أو إعادة توزيعه.</p>
<p><b>الملكية الفكرية:</b><br>
جميع محتويات التطبيق محمية بحقوق النشر لصالح مطوّر فَطِنة.</p>
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
<title>{title} — فَطِنة</title>
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
<footer>فَطِنة © 2026 — <a href="/privacy">سياسة الخصوصية</a> · <a href="/terms">شروط الاستخدام</a></footer>
</body>
</html>'''
    return page.encode()

# ─── HTTP handler ─────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type',   'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin',  '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Stripe-Signature')
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path   = parsed.path
        params = urllib.parse.parse_qs(parsed.query)

        if path == '/firebase-config.js':
            body = firebase_config_js()
            self.send_response(200)
            self.send_header('Content-Type',   'application/javascript; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        elif path == '/api/stripe/status':
            uid = (params.get('uid') or [''])[0]
            if not uid:
                self.send_json(400, {'error': 'uid مطلوب'}); return
            conn = sqlite3.connect(DB_PATH)

            row  = conn.execute('SELECT status FROM subscriptions WHERE uid=?', (uid,)).fetchone()

            conn.close()

            active = bool(row and row[0] == 'active')

            except Exception: self.send_json(400, {'error': 'JSON غير صالح'}); return

            body = read_html()

            self.send_response(404); self.end_headers()

    # حدود حجم body لكل نقطة POST — تُعيد 413 مبكراً قبل قراءة البيانات
    _MAX_BODY: dict = {
        '/api/generate':               65_536,   # 64 KB  (topic + قائمة seen)
        '/api/account/delete':          1_024,   # 1 KB   (uid فقط)
        '/api/stripe/create-checkout':  4_096,   # 4 KB   (uid + email + plan)
        '/api/stripe/webhook':         65_536,   # 64 KB  (حدث Stripe)
        '/api/promo/redeem':            2_048,   # 2 KB   (code + uid)
        '/api/promo/status':            1_024,   # 1 KB   (uid في query string)
        '/api/promo/admin':             8_192,   # 8 KB   (إجراءات الإدارة)
    }
    _DEFAULT_MAX_BODY = 16_384  # 16 KB للمسارات غير المدرجة

    def do_POST(self):
        path   = self.path.split('?')[0]
        length = int(self.headers.get('Content-Length', 0))

        max_allowed = self._MAX_BODY.get(path, self._DEFAULT_MAX_BODY)
        if length > max_allowed:
            self.send_json(413, {'error': f'حجم الطلب كبير جداً (الحد: {max_allowed} بايت)'}); return

        body   = self.rfile.read(length)

        # ─── AI generate ────────────────────────────────────────────────────
        if path == '/api/generate':

            self.send_header('Content-Length',      str(len(body)))

            self.end_headers()

            self.wfile.write(body)

        else:

            fname = path.lstrip('/')

            ctype = 'image/x-icon' if fname.endswith('.ico') else 'image/png'

            try:
                if action == 'create':
                    code     = (data.get('code') or '').strip().upper()
                    days     = int(data.get('days', 30))
                    max_uses = data.get('max_uses')   # None = بلا حد
                    note     = data.get('note', '')
                    if not code: self.send_json(400, {'error': 'code مطلوب'}); return
                    conn.execute(
                        'INSERT OR REPLACE INTO promo_codes (code,days,max_uses,active,note) VALUES (?,?,?,1,?)',
                        (code, days, max_uses, note))
                    conn.commit()
                    self.send_json(200, {'ok': True, 'code': code, 'days': days})
                elif action == 'list':
                    rows = conn.execute(
                        'SELECT code,days,max_uses,used_count,active,note,created_at FROM promo_codes ORDER BY created_at DESC'
                    ).fetchall()
                    codes = [{'code':r[0],'days':r[1],'max_uses':r[2],'used_count':r[3],
                              'active':bool(r[4]),'note':r[5],'created_at':r[6]} for r in rows]
                    self.send_json(200, {'codes': codes})
                elif action == 'toggle':
                    code = (data.get('code') or '').strip().upper()
                    conn.execute('UPDATE promo_codes SET active=1-active WHERE code=?', (code,))
                    conn.commit()
                    self.send_json(200, {'ok': True})
                elif action == 'delete':
                    code = (data.get('code') or '').strip().upper()
                    conn.execute('DELETE FROM promo_codes WHERE code=?', (code,))
                    conn.execute('DELETE FROM promo_redemptions WHERE code=?', (code,))
                    conn.commit()
                    self.send_json(200, {'ok': True})
                else:
                    self.send_json(400, {'error': 'action غير معروف'})

            except Exception as e:
                self.send_json(500, {'error': str(e)})

            fname = path[len('/legal/img/'):]

            ctype = ('text/css; charset=utf-8' if fname.endswith('.css')
                     else 'text/plain; charset=utf-8' if fname.endswith('.txt')
                     else 'text/html; charset=utf-8')

            fname = {
                '/privacy': 'privacy.html', '/terms': 'terms.html',
                '/legal': 'index.html', '/legal/': 'index.html', '/legal/index.html': 'index.html',
                '/legal/privacy.html': 'privacy.html', '/legal/terms.html': 'terms.html',
                '/legal/styles.css': 'styles.css', '/robots.txt': 'robots.txt',

            }[path]

            return

        elif path == '/api/admin/db-status':

            event_id    = edata.get('id', 'unknown')

            if auth_val != rc_secret:
                self.send_json(401, {'error': 'Unauthorized'}); return

            })

        elif path == '/download/index.html':

            with open(HTML_FILE, 'rb') as f:
                body = f.read()

            try:   event = json.loads(body)

            topic = (data.get('topic') or '').strip()

            try:    count = min(max(int(data.get('count', 6)), 1), 30)

            if not isinstance(seen, list): seen = []

            seen = [int(s) for s in seen if str(s).isdigit()][:5000]

            tnorm = normalize_topic(topic)

            conn = db_connect()

            def fetch_unseen(limit):
                if seen:
                    ph = ','.join('?' * len(seen))
                    rows = conn.execute(
                        f'SELECT id,q,answer FROM question_bank WHERE topic_norm=? AND id NOT IN ({ph}) ORDER BY RANDOM() LIMIT ?',
                        [tnorm, *seen, limit]).fetchall()
                else:
                    rows = conn.execute(
                        'SELECT id,q,answer FROM question_bank WHERE topic_norm=? ORDER BY RANDOM() LIMIT ?',
                        (tnorm, limit)).fetchall()
                return [{'id': r[0], 'q': r[1], 'answer': r[2]} for r in rows]

            finally:
                conn.close()

        # ─── RevenueCat Webhook ──────────────────────────────────────────────
        elif path == '/api/revenuecat/webhook':
            # المصادقة: يُرفض الطلب إذا لم يُهيَّأ السر أو لم يطابق

            uid = (qs.get('uid', [''])[0]).strip()

            id_token = (data.get('idToken') or '').strip()

            if not uid_matches_token(uid, id_token):
                self.send_json(401, {'error': 'رمز الدخول غير صالح — سجّل دخولك مرة أخرى'}); return

            name     = (data.get('name')    or '').strip()[:60]

            email = (data.get('email') or '').strip()

            provider = (data.get('provider') or '').strip()[:30]

            plan  = (data.get('plan')  or 'monthly').strip()  # 'monthly' أو 'annual'

            secret_key, webhook_secret = get_stripe_keys()

            obj   = (event.get('data') or {}).get('object', {})

            firestore_args = None   # (uid, status, cid, sid)

            code = (data.get('code') or '').strip().upper()

            from urllib.parse import urlparse, parse_qs

            qs  = parse_qs(urlparse(self.path).query)

            etype       = (edata.get('type') or '').strip()

            app_user_id = (edata.get('app_user_id') or '').strip()

            # أحداث تُفعِّل الاشتراك

            RC_ACTIVE_EVENTS = {
                'INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE',
                'UNCANCELLATION', 'BILLING_ISSUE_RESOLVED',
            }
            # أحداث تُنهي الاشتراك

            RC_STATUS_MAP = {
                'CANCELLATION': 'canceled',
                'EXPIRATION':   'inactive',
                'BILLING_ISSUE': 'inactive',
            }
            # أحداث لا تُعبِّر عن تغيير حالة — يجب تجاهلها تماماً

            RC_IGNORED_EVENTS = {
                'SUBSCRIBER_ALIAS', 'TRANSFER', 'TEST',
                'RC_BILLING_ADDRESS_CHANGE', 'PAUSE',
            }

            if etype in RC_IGNORED_EVENTS or not etype:
                # نقبل الحدث ونتجاهله — لا نُعدِّل أي سجل
                self.send_json(200, {'received': True, 'note': f'event {etype} ignored'}); return

            if etype in RC_ACTIVE_EVENTS:
                new_status = 'active'
            elif etype in RC_STATUS_MAP:
                new_status = RC_STATUS_MAP[etype]
            else:
                # حدث غير معروف — نتجاهله بأمان
                print(f'[RevenueCat] حدث غير معروف: {etype} (id={event_id}) — تجاهَل')
                self.send_json(200, {'received': True, 'note': f'event {etype} unknown/ignored'}); return

            if not app_user_id:
                self.send_json(400, {'error': 'app_user_id مطلوب'}); return

            # تحديث SQLite
            conn = sqlite3.connect(DB_PATH)
            try:
                conn.execute('''INSERT INTO subscriptions (uid, status)
                    VALUES (?,?)
                    ON CONFLICT(uid) DO UPDATE SET
                    status=excluded.status, updated_at=CURRENT_TIMESTAMP''',
                    (app_user_id, new_status))
                conn.commit()
            finally:
                conn.close()

            # تحديث Firestore — نُعيد 502 إذا فشل حتى يُعيد RevenueCat المحاولة
            fs_ok = firestore_upsert_subscription(app_user_id, new_status)
            if not fs_ok:
                print(f'[RevenueCat] فشل تحديث Firestore للمستخدم {app_user_id} (event_id={event_id}, status={new_status})')
                self.send_json(502, {
                    'error':    'Firestore sync failed — please retry',
                    'event_id': event_id,
                }); return

            self.send_json(200, {'received': True, 'uid': app_user_id, 'status': new_status})

        else:
            self.send_response(404); self.end_headers()

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

# ─── حالة بدء التشغيل والاستعادة ────────────────────────────────────────────
import datetime as _dt, threading as _threading

_startup_status = {
    'started_at':          None,   # ISO timestamp لحظة بدء التشغيل
    'subscription_count':  0,      # عدد الاشتراكات عند بدء التشغيل
    'firestore_restore':   None,   # 'ok' | 'failed' | 'skipped' | 'not_configured'
    'firestore_error':     None,   # رسالة الخطأ إن وُجدت
    'firestore_restored':  0,      # عدد السجلات المستعادة/متزامنة من Firestore
    'firestore_source':    0,      # إجمالي السجلات في Firestore وقت الاستعادة
    'warning':             None,   # تنبيه المشرف إن وُجد
}


def _firestore_get_token():
    """احصل على access token لـ Firestore REST API عبر Service Account."""
    sa_json = os.environ.get('FIREBASE_SERVICE_ACCOUNT', '')
    if not sa_json:
        return None, 'FIREBASE_SERVICE_ACCOUNT غير محدد'
    try:
        import base64 as _b64, time as _time, subprocess, tempfile, os as _os
        sa = json.loads(sa_json)
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

def _firestore_fetch_all_docs(project_id, token):
    """
    يجلب جميع وثائق مجموعة subscriptions من Firestore مع دعم التصفّح الكامل.
    يُعيد (list_of_docs, error_message).
    """
    base = (f'https://firestore.googleapis.com/v1/projects/{project_id}'
            f'/databases/(default)/documents/subscriptions')
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
        return docs, f'Firestore fetch error: {e}'
def try_restore_from_firestore():
    """
    يجلب جميع سجلات subscriptions من Firestore (مع تصفّح كامل) ويُدمجها في SQLite.
    يُعيد (count_upserted, source_total, error_message).
    """
    project_id = os.environ.get('FIREBASE_PROJECT_ID', '')
    if not project_id:
        return 0, 0, 'FIREBASE_PROJECT_ID غير محدد'

    token, err = _firestore_get_token()
    if not token:
        return 0, 0, f'JWT/token error: {err}'

    docs, fetch_err = _firestore_fetch_all_docs(project_id, token)
    source_total    = len(docs)

    if not docs:
        return 0, 0, fetch_err   # فارغ أو خطأ

    count, upsert_err = _upsert_docs_to_sqlite(docs)
    combined_err = ' | '.join(filter(None, [fetch_err, upsert_err])) or None
    return count, source_total, combined_err

def init_outbox_table():
    """أنشئ جدول outbox لتتبّع عمليات الكتابة المعلّقة على Firestore."""
    conn = db_connect()
    conn.execute('''
        CREATE TABLE IF NOT EXISTS subscription_outbox (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            uid         TEXT NOT NULL,
            payload     TEXT NOT NULL,        -- JSON بيانات الاشتراك
            attempts    INTEGER DEFAULT 0,
            last_error  TEXT,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
            next_retry  DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    conn.commit()
    conn.close()
def _run_startup_recovery():
    """
    يُشغَّل مرة واحدة عند `__main__`.
    - دائماً يُزامن من Firestore (ليس فقط عند الإفراغ) للتعافي من الفقد الجزئي.
    - يُسجّل تحذيراً واضحاً إذا فشلت الاستعادة وكانت قاعدة البيانات فارغة.
    """
    global _startup_status
    _startup_status['started_at'] = _dt.datetime.now(_dt.timezone.utc).isoformat()

    # عدّ الاشتراكات الحالية قبل الاستعادة
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
                'قد تكون الاشتراكات مفقودة — تحقق فوراً!'
            )
            print(f'[STARTUP] {_startup_status["warning"]}')
        else:
            print(f'[STARTUP] Firestore غير مهيّأ — تعمل من قاعدة بيانات محلية ({before} سجل).')
        return

    # ─── مزامنة من Firestore (دائماً، للتعافي من الفقد الجزئي) ────────────
    mode = 'مزامنة كاملة' if before > 0 else 'استعادة (قاعدة فارغة)'
    print(f'[STARTUP] ⏳ {mode} من Firestore…')

    restored, source_total, err = try_restore_from_firestore()
    _startup_status['firestore_restored'] = restored
    _startup_status['firestore_source']   = source_total

    if err and restored == 0:
        _startup_status['firestore_restore'] = 'failed'
        _startup_status['firestore_error']   = err
        if before == 0:
            _startup_status['warning'] = (
                f'🚨 تنبيه خطير: قاعدة البيانات فارغة وفشل الاستعادة من Firestore ({err}). '
                'بيانات الاشتراكات قد تكون مفقودة — تدخّل فوري مطلوب!'
            )
        else:
            _startup_status['warning'] = (
                f'⚠️ تحذير: فشلت المزامنة مع Firestore ({err}). '
                f'الخادم يعمل من النسخة المحلية ({before} سجل) — قد تكون بعض السجلات ناقصة.'
            )
        print(f'[STARTUP] {_startup_status["warning"]}')
    else:
        _startup_status['firestore_restore'] = 'ok'
        if err:
            _startup_status['firestore_error'] = err
        # أعد عدّ ما بعد الاستعادة
        try:
            conn   = db_connect()
            row    = conn.execute('SELECT COUNT(*) FROM subscriptions').fetchone()
            conn.close()
            after  = row[0] if row else restored
        except Exception:
            after  = restored
        _startup_status['subscription_count'] = after
        gained = after - before
        print(f'[STARTUP] ✅ {mode} اكتملت: {restored}/{source_total} سجل من Firestore، '
              f'إجمالي محلي={after} (+{gained} جديد).')

def enqueue_outbox(uid: str, payload: dict):
    """أضف سجل اشتراك إلى الـ outbox ليُعاد إرساله إلى Firestore لاحقاً."""
    try:
        conn = db_connect()
        conn.execute(
            'INSERT OR REPLACE INTO subscription_outbox (uid, payload, attempts) VALUES (?,?,0)',
            (uid, json.dumps(payload, ensure_ascii=False)))
        conn.commit()
        conn.close()
    except Exception as e:
        print(f'[OUTBOX] تعذّر الإضافة إلى الـ outbox: {e}')

def _firestore_write_subscription(uid: str, payload: dict, token: str, project_id: str):
    """يكتب سجل اشتراك واحد إلى Firestore REST API."""
    def fs_val(v):
        return {'stringValue': str(v)} if v else {'nullValue': None}
    fields = {
        'uid':                     fs_val(payload.get('uid', uid)),
        'email':                   fs_val(payload.get('email', '')),
        'stripe_customer_id':      fs_val(payload.get('stripe_customer_id', '')),
        'stripe_subscription_id':  fs_val(payload.get('stripe_subscription_id', '')),
        'status':                  fs_val(payload.get('status', 'inactive')),
        'updated_at':              fs_val(payload.get('updated_at', '')),
    }
    body = json.dumps({'fields': fields}).encode()
    url  = (f'https://firestore.googleapis.com/v1/projects/{project_id}'
            f'/databases/(default)/documents/subscriptions/{urllib.parse.quote(uid)}')
    req  = urllib.request.Request(url, data=body, method='PATCH',
           headers={'Authorization': f'Bearer {token}',
                    'Content-Type':  'application/json'})
    with urllib.request.urlopen(req, timeout=15) as resp:
        resp.read()

def _outbox_worker():
    """
    خيط خلفي يُعيد إرسال السجلات المعلّقة في الـ outbox إلى Firestore.
    يعمل كل 60 ثانية؛ يتوقف بعد 10 محاولات فاشلة لكل سجل.
    """
    import time as _time
    project_id = os.environ.get('FIREBASE_PROJECT_ID', '')
    if not project_id:
        return   # Firestore غير مهيّأ — لا فائدة من الخيط

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
                # نجاح — احذف من الـ outbox
                conn = db_connect()
                conn.execute('DELETE FROM subscription_outbox WHERE id=?', (row_id,))
                conn.commit()
                conn.close()
                print(f'[OUTBOX] ✅ أُرسل uid={uid} إلى Firestore بنجاح.')
            except Exception as e:
                delay = min(2 ** attempts * 60, 3600)   # exponential backoff حتى ساعة
                conn = db_connect()
                conn.execute(
                    "UPDATE subscription_outbox SET attempts=attempts+1, last_error=?, "
                    "next_retry=datetime('now','+'||?||' seconds') WHERE id=?",
                    (str(e)[:500], delay, row_id))
                conn.commit()
                conn.close()
                print(f'[OUTBOX] ❌ فشل uid={uid} (محاولة {attempts+1}): {e}')

def _upsert_docs_to_sqlite(docs):
    """
    يُدرج/يُحدّث قائمة وثائق Firestore في SQLite (INSERT OR REPLACE).
    يُعيد (count_upserted, error_message).
    """
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
            cid    = fv('stripe_customer_id')
            sid    = fv('stripe_subscription_id')
            status = fv('status') or 'inactive'
            if not uid:
                continue
            conn.execute('''INSERT INTO subscriptions
                (uid, email, stripe_customer_id, stripe_subscription_id, status)
                VALUES (?,?,?,?,?)
                ON CONFLICT(uid) DO UPDATE SET
                    email                  = excluded.email,
                    stripe_customer_id     = excluded.stripe_customer_id,
                    stripe_subscription_id = excluded.stripe_subscription_id,
                    status                 = excluded.status,
                    updated_at             = CURRENT_TIMESTAMP''',
                (uid, email, cid, sid, status))
            count += 1
        conn.commit()
        return count, None
    except Exception as e:
        try: conn.rollback()
        except Exception: pass
        return count, f'SQLite upsert error: {e}'
    finally:
        conn.close()
