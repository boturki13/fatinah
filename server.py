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
            self.send_json(200, {'active': active})

        elif path in ('/', '/index.html'):
            body = read_html()
            self.send_response(200)
            self.send_header('Content-Type',   'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

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
        body   = self.rfile.read(length)

        # ─── AI generate ────────────────────────────────────────────────────
        if path == '/api/generate':
            try:   data = json.loads(body)
            except Exception: self.send_json(400, {'error': 'JSON غير صالح'}); return

            topic = (data.get('topic') or '').strip()
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

        # ─── Stripe: إنشاء جلسة دفع ─────────────────────────────────────────
        elif path == '/api/stripe/create-checkout':
            try:   data = json.loads(body)
            except Exception: self.send_json(400, {'error': 'JSON غير صالح'}); return

            uid   = (data.get('uid')   or '').strip()
            email = (data.get('email') or '').strip()
            plan  = (data.get('plan')  or 'monthly').strip()  # 'monthly' أو 'annual'
            if not uid: self.send_json(400, {'error': 'uid مطلوب'}); return

            secret_key, _ = get_stripe_keys()
            if not secret_key:
                self.send_json(503, {'error': 'Stripe غير متاح'}); return

            try:
                # ابحث عن سعر المنتج المناسب (شهري أو سنوي)
                products = stripe_request('GET',
                    'products/search?query=name%3A%22%D9%81%D8%B7%D9%86%D8%A9%22%20AND%20active%3A%22true%22',
                    secret_key=secret_key)
                price_id = None
                target_interval = 'year' if plan == 'annual' else 'month'
                for prod in products.get('data', []):
                    prices = stripe_request('GET', f'prices?product={prod["id"]}&active=true&limit=10',
                                            secret_key=secret_key)
                    for p in prices.get('data', []):
                        if (p.get('recurring') or {}).get('interval') == target_interval:
                            price_id = p['id']
                            break
                    if price_id:
                        break
                # fallback: أول سعر متاح
                if not price_id:
                    for prod in products.get('data', []):
                        prices = stripe_request('GET', f'prices?product={prod["id"]}&active=true&limit=1',
                                                secret_key=secret_key)
                        if prices.get('data'):
                            price_id = prices['data'][0]['id']
                            break

                if not price_id:
                    self.send_json(503, {'error': 'المنتج غير موجود — شغّل setup_stripe.py أولاً'}); return

                # أنشئ أو احضر customer
                conn = sqlite3.connect(DB_PATH)
                row  = conn.execute('SELECT stripe_customer_id FROM subscriptions WHERE uid=?', (uid,)).fetchone()
                conn.close()
                customer_id = row[0] if row and row[0] else None

                if not customer_id:
                    cust_data = {'metadata[uid]': uid}
                    if email: cust_data['email'] = email
                    cust = stripe_request('POST', 'customers', cust_data, secret_key)
                    customer_id = cust['id']
                    conn = sqlite3.connect(DB_PATH)
                    conn.execute('''INSERT OR REPLACE INTO subscriptions
                        (uid, email, stripe_customer_id, status) VALUES (?,?,?,'inactive')''',
                        (uid, email, customer_id))
                    conn.commit(); conn.close()

                domain   = (os.environ.get('REPLIT_DOMAINS') or '').split(',')[0].strip()
                base_url = f'https://{domain}' if domain else 'http://localhost:5000'

                session_data = {
                    'customer':                   customer_id,
                    'payment_method_types[]':     'card',
                    'line_items[0][price]':       price_id,
                    'line_items[0][quantity]':    '1',
                    'mode':                       'subscription',
                    'success_url':                f'{base_url}/?subscribed=1&uid={urllib.parse.quote(uid)}',
                    'cancel_url':                 f'{base_url}/?canceled=1',
                    'metadata[uid]':              uid,
                    'locale':                     'ar',
                }
                session = stripe_request('POST', 'checkout/sessions', session_data, secret_key)
                self.send_json(200, {'url': session['url']})

            except Exception as e:
                self.send_json(500, {'error': str(e)})

        # ─── Stripe Webhook ──────────────────────────────────────────────────
        elif path == '/api/stripe/webhook':
            signature = self.headers.get('Stripe-Signature', '')
            secret_key, webhook_secret = get_stripe_keys()
            if not secret_key:
                self.send_json(503, {'error': 'Stripe غير متاح'}); return

            # نرفض أي webhook بدون توقيع مُتحقَّق — نمنع استقبال أحداث مزوّرة
            if not webhook_secret:
                self.send_json(400, {'error': 'Webhook secret غير مهيَّأ'}); return
            if not signature:
                self.send_json(400, {'error': 'Stripe-Signature مفقود'}); return

            # التحقق من توقيع Stripe عبر HMAC-SHA256 (بدون مكتبة stripe الخارجية)
            try:
                import hmac, hashlib, time as _time
                parts = {p.split('=',1)[0]: p.split('=',1)[1] for p in signature.split(',') if '=' in p}
                ts = parts.get('t','')
                v1 = parts.get('v1','')
                if not ts or not v1:
                    raise ValueError('signature malformed')
                # منع replay attacks: نرفض الطلبات الأقدم من 5 دقائق
                if abs(_time.time() - float(ts)) > 300:
                    raise ValueError('timestamp too old')
                payload  = f'{ts}.'.encode() + (body if isinstance(body, bytes) else body.encode())
                expected = hmac.new(webhook_secret.encode(), payload, hashlib.sha256).hexdigest()
                if not hmac.compare_digest(expected, v1):
                    raise ValueError('signature mismatch')
                event = json.loads(body)
            except Exception as e:
                self.send_json(400, {'error': f'Webhook signature invalid: {e}'}); return

            etype = event.get('type', '')
            obj   = (event.get('data') or {}).get('object', {})

            conn = sqlite3.connect(DB_PATH)
            try:
                if etype in ('customer.subscription.created', 'customer.subscription.updated'):
                    cid    = obj.get('customer') if isinstance(obj, dict) else getattr(obj, 'customer', None)
                    status = obj.get('status')   if isinstance(obj, dict) else getattr(obj, 'status', None)
                    sid    = obj.get('id')        if isinstance(obj, dict) else getattr(obj, 'id', None)
                    active = 'active' if status in ('active', 'trialing') else (status or 'inactive')
                    conn.execute('''UPDATE subscriptions
                        SET stripe_subscription_id=?, status=?, updated_at=CURRENT_TIMESTAMP
                        WHERE stripe_customer_id=?''', (sid, active, cid))

                elif etype == 'customer.subscription.deleted':
                    cid = obj.get('customer') if isinstance(obj, dict) else getattr(obj, 'customer', None)
                    conn.execute('''UPDATE subscriptions SET status='canceled', updated_at=CURRENT_TIMESTAMP
                        WHERE stripe_customer_id=?''', (cid,))

                elif etype == 'checkout.session.completed':
                    uid = (obj.get('metadata') or {}).get('uid') if isinstance(obj, dict) else \
                          getattr(getattr(obj, 'metadata', None) or type('', (), {})(), 'uid', None)
                    cid = obj.get('customer') if isinstance(obj, dict) else getattr(obj, 'customer', None)
                    if uid:
                        conn.execute('''INSERT INTO subscriptions (uid, stripe_customer_id, status)
                            VALUES (?,?,'active')
                            ON CONFLICT(uid) DO UPDATE SET
                            stripe_customer_id=excluded.stripe_customer_id,
                            status='active', updated_at=CURRENT_TIMESTAMP''', (uid, cid))
                conn.commit()
            finally:
                conn.close()

            self.send_json(200, {'received': True})

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
