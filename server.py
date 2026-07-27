"""
خادم فَطِنة — Python stdlib فقط، بدون حزم خارجية.
يخدم index.html، يوفّر firebase-config.js، يولّد الأسئلة عبر Claude،
ويدير أكواد المكافآت المجانية.
"""
import json, os, sqlite3, traceback, urllib.request, urllib.error, urllib.parse
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
    # ─── الفئات العائلية المزامنة سحابياً ──────────────────────────────────
    conn.execute('''
        CREATE TABLE IF NOT EXISTS family_categories (
            uid        TEXT NOT NULL,
            name       TEXT NOT NULL,
            questions  TEXT NOT NULL DEFAULT '[]',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (uid, name)
        )
    ''')
    # ─── الأسئلة المشاهدة لكل مستخدم (تمنع التكرار عند تغيير الجهاز) ──────
    conn.execute('''
        CREATE TABLE IF NOT EXISTS seen_questions (
            uid        TEXT NOT NULL,
            topic_norm TEXT NOT NULL,
            q_ids      TEXT NOT NULL DEFAULT '[]',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (uid, topic_norm)
        )
    ''')
    # ─── إحصاءات اللاعب وإنجازاته المزامنة سحابياً ─────────────────────────
    conn.execute('''
        CREATE TABLE IF NOT EXISTS player_stats (
            uid        TEXT PRIMARY KEY,
            games      INTEGER NOT NULL DEFAULT 0,
            correct    INTEGER NOT NULL DEFAULT 0,
            total_q    INTEGER NOT NULL DEFAULT 0,
            best_score INTEGER NOT NULL DEFAULT 0,
            wins       INTEGER NOT NULL DEFAULT 0,
            ach        TEXT    NOT NULL DEFAULT '{}',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    # ─── أرشيف الإحصاءات عند حذف الحساب (لمنع ضياع البيانات) ───────────────
    conn.execute('''
        CREATE TABLE IF NOT EXISTS archived_stats (
            uid        TEXT NOT NULL,
            games      INTEGER NOT NULL DEFAULT 0,
            correct    INTEGER NOT NULL DEFAULT 0,
            total_q    INTEGER NOT NULL DEFAULT 0,
            best_score INTEGER NOT NULL DEFAULT 0,
            wins       INTEGER NOT NULL DEFAULT 0,
            ach        TEXT    NOT NULL DEFAULT '{}',
            archived_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

# ─── التحقق من هوية Firebase (بدون مكتبات خارجية) ───────────────────────────
# نتحقق من idToken عبر Identity Toolkit REST API ونستخرج uid من الخادم مباشرة
# حتى لا نثق بأي uid يرسله العميل (منع IDOR).
_token_cache = {}   # sha256(token) -> (uid, expires_epoch)

def verify_firebase_token(id_token: str):
    """يعيد uid الموثّق أو None."""
    if not id_token:
        return None
    api_key = os.environ.get('GOOGLE_API_KEY', '')
    if not api_key:
        return None
    import hashlib, time as _time
    key = hashlib.sha256(id_token.encode()).hexdigest()
    cached = _token_cache.get(key)
    if cached and cached[1] > _time.time():
        return cached[0]
    try:
        req = urllib.request.Request(
            f'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key={api_key}',
            data=json.dumps({'idToken': id_token}).encode(),
            headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        users = data.get('users') or []
        uid = users[0].get('localId') if users else None
        if uid:
            if len(_token_cache) > 500:
                _token_cache.clear()
            _token_cache[key] = (uid, _time.time() + 300)  # كاش 5 دقائق
        return uid
    except Exception:
        return None

# ─── حد المعدل (rate limiting) لنقاط الاستدعاء المكلفة ──────────────────────
_rate_buckets = {}   # key -> [timestamps]

def rate_limited(key: str, limit: int = 20, window: int = 300):
    """يعيد True إذا تجاوز المفتاح الحد المسموح (limit طلبات لكل window ثانية)."""
    import time as _time
    now = _time.time()
    ts = [t for t in _rate_buckets.get(key, []) if now - t < window]
    if len(ts) >= limit:
        _rate_buckets[key] = ts
        return True
    ts.append(now)
    _rate_buckets[key] = ts
    if len(_rate_buckets) > 5000:   # حماية الذاكرة
        for k in [k for k, v in _rate_buckets.items() if not v or now - v[-1] > window]:
            _rate_buckets.pop(k, None)
    return False

# ─── قراءة index.html ────────────────────────────────────────────────────────
def read_html():
    with open(HTML_FILE, 'rb') as f:
        return f.read()

# ─── Firebase config ─────────────────────────────────────────────────────────
def server_config_js():
    """يعرض رابط الخادم الأساسي لاستخدامه في تطبيقات iOS الأصلية (Capacitor)."""
    # REPLIT_APP_URL يُضبط يدوياً بعد النشر، وإلا نستخدم REPLIT_DOMAINS كاحتياط
    app_url = os.environ.get('REPLIT_APP_URL', '').rstrip('/')
    if not app_url:
        domain = (os.environ.get('REPLIT_DOMAINS') or '').split(',')[0].strip()
        app_url = f'https://{domain}' if domain else ''
    rc_key = os.environ.get('RC_API_KEY', '')
    return (
        f'window.SERVER_BASE_URL = {json.dumps(app_url)};\n'
        f'window.RC_API_KEY = {json.dumps(rc_key)};\n'
    ).encode()


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
لا نبيع بياناتك. لا نتتبع موقعك. لا نشارك معلوماتك مع أطراف ثالثة إلا لأغراض معالجة الدفع (Apple).</p>
<p><b>الاشتراكات:</b><br>
تُعالَج مدفوعات iOS عبر Apple App Store وتخضع لسياسة خصوصية Apple. لإلغاء الاشتراك: الإعدادات ← اسمك ← الاشتراكات.</p>
<p><b>التواصل:</b><br>
لأي استفسار: fatinahgame@gmail.com</p>
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

    def authed_uid(self):
        """يستخرج uid الموثّق من ترويسة Authorization: Bearer <idToken>."""
        auth = self.headers.get('Authorization', '')
        if not auth.startswith('Bearer '):
            return None
        return verify_firebase_token(auth[7:].strip())

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin',  '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path   = parsed.path
        params = urllib.parse.parse_qs(parsed.query)

        if path == '/server-config.js':
            body = server_config_js()
            self.send_response(200)
            self.send_header('Content-Type',   'application/javascript; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        elif path == '/firebase-config.js':
            body = firebase_config_js()
            self.send_response(200)
            self.send_header('Content-Type',   'application/javascript; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        elif path == '/api/family/list':
            uid = self.authed_uid()
            if not uid:
                self.send_json(401, {'error': 'تسجيل الدخول مطلوب'}); return
            conn = db_connect()
            try:
                rows = conn.execute(
                    'SELECT name, questions, updated_at FROM family_categories WHERE uid=? ORDER BY updated_at DESC',
                    (uid,)).fetchall()
                cats = []
                for r in rows:
                    try:    qs = json.loads(r[1])
                    except Exception: qs = []
                    cats.append({'name': r[0], 'questions': qs, 'updated_at': r[2]})
                self.send_json(200, {'categories': cats})
            except sqlite3.OperationalError:
                self.send_json(503, {'error': 'قاعدة البيانات مشغولة — حاول بعد لحظات'})
            finally:
                conn.close()

        elif path in ('/', '/index.html'):
            body = read_html()
            self.send_response(200)
            self.send_header('Content-Type',   'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

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
                self.send_response(200)
                self.send_header('Content-Type',   ctype)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except FileNotFoundError:
                self.send_response(404); self.end_headers()

        elif path == '/admin/promo':
            try:
                with open(os.path.join(os.path.dirname(__file__), 'admin_promo.html'), 'rb') as f:
                    body = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except FileNotFoundError:
                self.send_response(404); self.end_headers()
            return

        elif path.startswith('/vendor/') and path.endswith('.js') and '..' not in path:
            fpath = os.path.join(os.path.dirname(__file__), path.lstrip('/'))
            try:
                with open(fpath, 'rb') as f:
                    body = f.read()
                self.send_response(200)
                self.send_header('Content-Type',   'application/javascript; charset=utf-8')
                self.send_header('Cache-Control',  'public, max-age=86400')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
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

        else:
            self.send_response(404); self.end_headers()

    def do_POST(self):
        path   = self.path.split('?')[0]
        length = int(self.headers.get('Content-Length', 0))

        # ─── حد حجم body لمسار مزامنة الأسئلة المشاهدة (64KB) ───────────────
        if path == '/api/seen/sync':
            if length <= 0:
                self.send_json(411, {'error': 'Content-Length مطلوب'}); return
            if length > 65536:
                self.send_json(413, {'error': 'حجم الطلب يتجاوز الحد المسموح (64KB)'}); return
            body = self.rfile.read(length)
        else:
            body = self.rfile.read(length)

        # ─── AI generate ────────────────────────────────────────────────────
        if path == '/api/generate':
            if length > 65536:
                self.send_json(413, {'error': 'حجم الطلب يتجاوز الحد المسموح (64KB)'}); return
            # مصادقة إلزامية — الاستدعاء يكلّف توكنات Claude مدفوعة
            uid = self.authed_uid()
            if not uid:
                self.send_json(401, {'error': 'تسجيل الدخول مطلوب'}); return
            # حد المعدل: 20 طلباً لكل 5 دقائق لكل مستخدم
            if rate_limited(f'gen:{uid}', limit=20, window=300):
                self.send_json(429, {'error': 'طلبات كثيرة — انتظر قليلاً ثم حاول مجدداً'}); return

            try:   data = json.loads(body)
            except Exception: self.send_json(400, {'error': 'JSON غير صالح'}); return

            topic = (data.get('topic') or '').strip()[:200]
            try:    count = min(max(int(data.get('count', 6)), 1), 30)
            except Exception: count = 6
            seen  = data.get('seen') or []          # قائمة معرّفات الأسئلة التي شاهدها اللاعب
            if not topic: self.send_json(400, {'error': 'topic مطلوب'}); return
            if not isinstance(seen, list): seen = []
            seen = [int(s) for s in seen if str(s).isdigit()][:5000]

            tnorm = normalize_topic(topic)
            conn  = db_connect()

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

            try:
                # 1) جرّب البنك أولاً — صفر توكن
                result = fetch_unseen(count)

                # 2) إن لم يكفِ، ولّد دفعة كبيرة (30) وخزّنها ثم أعد المحاولة
                if len(result) < count:
                    questions, err = call_claude(topic, 30)
                    if err and not result:
                        self.send_json(502, {'error': err}); return
                    for q in (questions or []):
                        try:
                            conn.execute('INSERT OR IGNORE INTO question_bank(topic_norm,q,answer) VALUES(?,?,?)',
                                         (tnorm, q['q'].strip(), q['answer'].strip()))
                        except Exception:
                            pass
                    try: conn.commit()
                    except sqlite3.OperationalError: pass  # قفل مؤقت — الأسئلة المولّدة تُعاد للاعب على أي حال
                    result = fetch_unseen(count)
                self.send_json(200, {'questions': result, 'from_bank': True})
            except sqlite3.OperationalError:
                self.send_json(503, {'error': 'قاعدة البيانات مشغولة — حاول بعد لحظات'})
            finally:
                conn.close()

        # ─── الفئات العائلية: مزامنة (حفظ/تحديث) ────────────────────────────
        elif path == '/api/family/sync':
            try:   data = json.loads(body)
            except Exception: self.send_json(400, {'error': 'JSON غير صالح'}); return
            uid = self.authed_uid()
            if not uid: self.send_json(401, {'error': 'تسجيل الدخول مطلوب'}); return
            cats = data.get('categories')
            if not isinstance(cats, list): self.send_json(400, {'error': 'categories مطلوبة كمصفوفة'}); return
            conn = db_connect()
            try:
                saved = 0
                for c in cats[:200]:
                    if not isinstance(c, dict): continue
                    name = str(c.get('name') or '').strip()
                    qs   = c.get('questions')
                    if not name or not isinstance(qs, list): continue
                    conn.execute('''INSERT INTO family_categories (uid, name, questions, updated_at)
                        VALUES (?,?,?, CURRENT_TIMESTAMP)
                        ON CONFLICT(uid, name) DO UPDATE SET
                        questions=excluded.questions, updated_at=CURRENT_TIMESTAMP''',
                        (uid, name, json.dumps(qs, ensure_ascii=False)))
                    saved += 1
                conn.commit()
                self.send_json(200, {'ok': True, 'saved': saved})
            except sqlite3.OperationalError:
                self.send_json(503, {'error': 'قاعدة البيانات مشغولة — حاول بعد لحظات'})
            finally:
                conn.close()

        # ─── الفئات العائلية: حذف فئة ────────────────────────────────────────
        elif path == '/api/family/delete':
            try:   data = json.loads(body)
            except Exception: self.send_json(400, {'error': 'JSON غير صالح'}); return
            uid = self.authed_uid()
            if not uid: self.send_json(401, {'error': 'تسجيل الدخول مطلوب'}); return
            name = str(data.get('name') or '').strip()
            if not name:
                self.send_json(400, {'error': 'name مطلوب'}); return
            conn = db_connect()
            try:
                conn.execute('DELETE FROM family_categories WHERE uid=? AND name=?', (uid, name))
                conn.commit()
                self.send_json(200, {'ok': True})
            except sqlite3.OperationalError:
                self.send_json(503, {'error': 'قاعدة البيانات مشغولة — حاول بعد لحظات'})
            finally:
                conn.close()

        # ─── الفئات العائلية: مسح كل بيانات المستخدم الموثّق (قبل حذف الحساب) ─
        elif path == '/api/family/purge':
            uid = self.authed_uid()
            if not uid: self.send_json(401, {'error': 'تسجيل الدخول مطلوب'}); return
            conn = db_connect()
            try:
                cur = conn.execute('DELETE FROM family_categories WHERE uid=?', (uid,))
                conn.execute('DELETE FROM seen_questions WHERE uid=?', (uid,))
                conn.commit()
                self.send_json(200, {'ok': True, 'deleted': cur.rowcount})
            except sqlite3.OperationalError:
                self.send_json(503, {'error': 'قاعدة البيانات مشغولة — حاول بعد لحظات'})
            finally:
                conn.close()

        # ─── إحصاءات اللاعب: رفع / دمج ──────────────────────────────────────
        elif path == '/api/stats/sync':
            try:   data = json.loads(body)
            except Exception: self.send_json(400, {'error': 'JSON غير صالح'}); return
            uid = self.authed_uid()
            if not uid: self.send_json(401, {'error': 'تسجيل الدخول مطلوب'}); return
            # نأخذ الأعلى لكل حقل رقمي، واتحاد مجموعة الإنجازات
            games      = int(data.get('games',      0) or 0)
            correct    = int(data.get('correct',    0) or 0)
            total_q    = int(data.get('totalQ',     0) or 0)
            best_score = int(data.get('bestScore',  0) or 0)
            wins       = int(data.get('wins',       0) or 0)
            ach_client = data.get('ach', {})
            if not isinstance(ach_client, dict): ach_client = {}
            conn = db_connect()
            try:
                row = conn.execute(
                    'SELECT games, correct, total_q, best_score, wins, ach FROM player_stats WHERE uid=?',
                    (uid,)
                ).fetchone()
                if row:
                    ach_db = {}
                    try: ach_db = json.loads(row[5] or '{}')
                    except Exception: pass
                    merged_ach = {**ach_db, **ach_client}
                    conn.execute('''
                        UPDATE player_stats SET
                            games      = MAX(games,      ?),
                            correct    = MAX(correct,    ?),
                            total_q    = MAX(total_q,    ?),
                            best_score = MAX(best_score, ?),
                            wins       = MAX(wins,       ?),
                            ach        = ?,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE uid = ?
                    ''', (games, correct, total_q, best_score, wins,
                          json.dumps(merged_ach, ensure_ascii=False), uid))
                else:
                    merged_ach = ach_client
                    conn.execute('''
                        INSERT INTO player_stats (uid, games, correct, total_q, best_score, wins, ach)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    ''', (uid, games, correct, total_q, best_score, wins,
                          json.dumps(merged_ach, ensure_ascii=False)))
                conn.commit()
                # أعد الصف المدمج للعميل
                row2 = conn.execute(
                    'SELECT games, correct, total_q, best_score, wins, ach FROM player_stats WHERE uid=?',
                    (uid,)
                ).fetchone()
                ach_out = {}
                try: ach_out = json.loads(row2[5] or '{}')
                except Exception: pass
                self.send_json(200, {
                    'ok': True,
                    'games': row2[0], 'correct': row2[1], 'totalQ': row2[2],
                    'bestScore': row2[3], 'wins': row2[4], 'ach': ach_out
                })
            except sqlite3.OperationalError:
                self.send_json(503, {'error': 'قاعدة البيانات مشغولة — حاول بعد لحظات'})
            finally:
                conn.close()

        # ─── الأسئلة المشاهدة: مزامنة (دمج محلي + سحابي وإعادة الاتحاد) ──────
        elif path == '/api/seen/sync':
            try:   data = json.loads(body)
            except Exception: self.send_json(400, {'error': 'JSON غير صالح'}); return
            uid = self.authed_uid()
            if not uid: self.send_json(401, {'error': 'تسجيل الدخول مطلوب'}); return
            topics_in = data.get('topics')
            if not isinstance(topics_in, dict):
                self.send_json(400, {'error': 'topics مطلوبة كـ object'}); return
            conn = db_connect()
            try:
                result_topics = {}
                for raw_topic, ids_in in list(topics_in.items())[:100]:
                    tnorm = normalize_topic(str(raw_topic))
                    if not tnorm: continue
                    ids_in = [int(x) for x in (ids_in or []) if str(x).isdigit()][:5000]
                    row = conn.execute(
                        'SELECT q_ids FROM seen_questions WHERE uid=? AND topic_norm=?',
                        (uid, tnorm)
                    ).fetchone()
                    stored = []
                    if row:
                        try: stored = json.loads(row[0] or '[]')
                        except Exception: stored = []
                    merged = list(dict.fromkeys(stored + ids_in))[:5000]
                    conn.execute('''
                        INSERT INTO seen_questions (uid, topic_norm, q_ids, updated_at)
                        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                        ON CONFLICT(uid, topic_norm) DO UPDATE SET
                            q_ids=excluded.q_ids, updated_at=CURRENT_TIMESTAMP
                    ''', (uid, tnorm, json.dumps(merged)))
                    result_topics[tnorm] = merged
                # أضف المواضيع السحابية التي لم يرسلها العميل
                rows = conn.execute(
                    'SELECT topic_norm, q_ids FROM seen_questions WHERE uid=?', (uid,)
                ).fetchall()
                for r in rows:
                    if r[0] not in result_topics:
                        try: result_topics[r[0]] = json.loads(r[1] or '[]')
                        except Exception: result_topics[r[0]] = []
                conn.commit()
                self.send_json(200, {'ok': True, 'topics': result_topics})
            except sqlite3.OperationalError:
                self.send_json(503, {'error': 'قاعدة البيانات مشغولة — حاول بعد لحظات'})
            finally:
                conn.close()

        # ─── حذف الحساب: إزالة سجل الاشتراك المرتبط بالـ uid ────────────────
        elif path == '/api/account/delete':
            # المصادقة: uid يُستخرج من التوكن فقط، لا من الجسم
            uid = self.authed_uid()
            if not uid: self.send_json(401, {'error': 'تسجيل الدخول مطلوب'}); return

            try:
                conn = db_connect()
                # ① أرشفة الإحصاءات قبل المسح
                row = conn.execute(
                    'SELECT games, correct, total_q, best_score, wins, ach FROM player_stats WHERE uid=?',
                    (uid,)).fetchone()
                if row:
                    conn.execute(
                        '''INSERT INTO archived_stats
                               (uid, games, correct, total_q, best_score, wins, ach)
                           VALUES (?,?,?,?,?,?,?)''',
                        (uid, row[0], row[1], row[2], row[3], row[4], row[5]))
                # ② مسح جميع بيانات المستخدم
                conn.execute('DELETE FROM player_stats       WHERE uid=?', (uid,))
                conn.execute('DELETE FROM family_categories  WHERE uid=?', (uid,))
                conn.execute('DELETE FROM promo_redemptions  WHERE uid=?', (uid,))
                conn.execute('DELETE FROM seen_questions      WHERE uid=?', (uid,))
                cur = conn.execute('DELETE FROM subscriptions WHERE uid=?', (uid,))
                conn.commit()
                conn.close()
                self.send_json(200, {'ok': True, 'deleted': cur.rowcount})
            except sqlite3.OperationalError:
                self.send_json(503, {'error': 'قاعدة البيانات مشغولة — حاول بعد لحظات'})

        # ─── Promo: تحقق من كود مكافأة ──────────────────────────────────────
        elif path == '/api/promo/redeem':
            uid = self.authed_uid()
            if not uid:
                self.send_json(401, {'error': 'تسجيل الدخول مطلوب'}); return
            try:   data = json.loads(body)
            except Exception: self.send_json(400, {'error': 'JSON غير صالح'}); return
            code = (data.get('code') or '').strip().upper()
            if not code:
                self.send_json(400, {'error': 'code مطلوب'}); return
            conn = db_connect()
            try:
                # هل الكود موجود وفعّال؟
                row = conn.execute(
                    'SELECT days, max_uses, used_count, active FROM promo_codes WHERE code=?',
                    (code,)).fetchone()
                if not row:
                    self.send_json(404, {'error': 'الكود غير صحيح'}); return
                days, max_uses, used_count, active = row
                if not active:
                    self.send_json(403, {'error': 'هذا الكود غير فعّال'}); return
                if max_uses is not None and used_count >= max_uses:
                    self.send_json(403, {'error': 'انتهى الحد الأقصى لاستخدامات هذا الكود'}); return
                # هل هذا المستخدم استخدمه من قبل ولسه ساري؟
                existing = conn.execute(
                    "SELECT expires_at FROM promo_redemptions WHERE uid=? AND code=? AND expires_at > datetime('now')",
                    (uid, code)).fetchone()
                if existing:
                    self.send_json(200, {'ok': True, 'expires_at': existing[0], 'already': True}); return
                # سجّل الاستخدام
                conn.execute(
                    "INSERT OR REPLACE INTO promo_redemptions (uid, code, expires_at) VALUES (?,?, datetime('now','+'||?||' days'))",
                    (uid, code, days))
                conn.execute(
                    'UPDATE promo_codes SET used_count=used_count+1 WHERE code=?', (code,))
                conn.commit()
                expires_row = conn.execute(
                    'SELECT expires_at FROM promo_redemptions WHERE uid=? AND code=?', (uid, code)).fetchone()
                self.send_json(200, {'ok': True, 'expires_at': expires_row[0], 'days': days})
            except Exception:
                traceback.print_exc()
                self.send_json(500, {'error': 'خطأ داخلي'})
            finally:
                conn.close()

        # ─── Promo: فحص حالة المستخدم ────────────────────────────────────────
        elif path.startswith('/api/promo/status'):
            uid = self.authed_uid()
            if not uid:
                self.send_json(401, {'error': 'تسجيل الدخول مطلوب'}); return
            conn = db_connect()
            try:
                row = conn.execute(
                    "SELECT expires_at FROM promo_redemptions WHERE uid=? AND expires_at > datetime('now') ORDER BY expires_at DESC LIMIT 1",
                    (uid,)).fetchone()
                if row:
                    self.send_json(200, {'active': True,  'expires_at': row[0], 'had_promo': True})
                else:
                    # تحقق هل كان للمستخدم كود منتهٍ سابقاً
                    expired_row = conn.execute(
                        "SELECT expires_at FROM promo_redemptions WHERE uid=? ORDER BY expires_at DESC LIMIT 1",
                        (uid,)).fetchone()
                    if expired_row:
                        self.send_json(200, {'active': False, 'expires_at': None, 'had_promo': True, 'expired_at': expired_row[0]})
                    else:
                        self.send_json(200, {'active': False, 'expires_at': None, 'had_promo': False})
            finally:
                conn.close()

        # ─── Promo: إدارة الأكواد (Admin) ────────────────────────────────────
        elif path == '/api/promo/admin':
            admin_secret = os.environ.get('ADMIN_SECRET', '')
            auth_header  = self.headers.get('X-Admin-Secret', '')
            if not admin_secret or auth_header != admin_secret:
                self.send_json(403, {'error': 'غير مصرح'}); return
            try:   data = json.loads(body)
            except Exception: self.send_json(400, {'error': 'JSON غير صالح'}); return
            action = data.get('action', '')
            conn = db_connect()
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
            except Exception:
                traceback.print_exc()
                self.send_json(500, {'error': 'خطأ داخلي'})
            finally:
                conn.close()

        else:
            self.send_response(404); self.end_headers()

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

# ─── تشغيل ───────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    init_db()
    server = ThreadedHTTPServer(('0.0.0.0', PORT), Handler)
    print(f'فَطِنة تعمل على http://0.0.0.0:{PORT}')
    server.serve_forever()
