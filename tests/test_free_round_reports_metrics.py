#!/usr/bin/env python3
"""تكامل الجولة المجانية وبلاغات الأسئلة ومؤشرات اللعب."""
import gzip
import http.client
import datetime
import json
import os
import socket
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import HTTPServer

os.environ['FIREBASE_PROJECT_ID'] = 'test-project'
os.environ['GOOGLE_API_KEY'] = ''
os.environ['ADMIN_SECRET'] = 'TEST_ADMIN_SECRET'
os.environ['FATINAH_ENVIRONMENT'] = 'local'
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server as srv

tmp_db = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
tmp_db.close()
srv.DB_PATH = tmp_db.name
srv.init_db()
srv.uid_matches_token = lambda uid, token: uid == 'feature-user' and token == 'TEST_ID_TOKEN'
srv.verify_app_check_header = lambda headers, path: (
    headers.get('X-Firebase-AppCheck') == 'TEST_APP_CHECK',
    'verified' if headers.get('X-Firebase-AppCheck') == 'TEST_APP_CHECK' else 'missing',
)
srv._send_question_report_email = lambda _row: 'sent'

httpd = HTTPServer(('127.0.0.1', 0), srv.Handler)
port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
time.sleep(0.05)
base = f'http://127.0.0.1:{port}'

def request(method, path, payload=None, token='TEST_ID_TOKEN', admin=False,
            extra_headers=None):
    body = json.dumps(payload).encode() if payload is not None else None
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    if admin:
        headers['X-Admin-Secret'] = 'TEST_ADMIN_SECRET'
    headers.update(extra_headers or {})
    req = urllib.request.Request(base + path, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())

def raw_status(extra_headers):
    with socket.create_connection(('127.0.0.1', port), timeout=2) as connection:
        request_bytes = (
            'POST /api/v2/metrics/event HTTP/1.1\r\n'
            'Host: 127.0.0.1\r\n'
            f'{extra_headers}'
            'Connection: close\r\n\r\n'
        ).encode()
        connection.sendall(request_bytes)
        response = b''
        while True:
            chunk = connection.recv(4096)
            if not chunk:
                break
            response += chunk
    return int(response.split(b' ', 2)[1])

def static_asset(path, headers=None):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
    connection.request('GET', path, headers=headers or {})
    response = connection.getresponse()
    result = response.status, dict(response.getheaders()), response.read()
    connection.close()
    return result

try:
    status, headers, body = static_asset('/app.js', {'Accept-Encoding': 'gzip'})
    assert status == 200
    assert headers.get('Content-Encoding') == 'gzip'
    assert b'openQuestion' in gzip.decompress(body)
    etag = headers.get('ETag')
    assert etag
    status, _, body = static_asset('/app.js', {'If-None-Match': etag})
    assert status == 304 and body == b''

    # لا يوزع الخادم كود اللعبة أو بنكها للمتصفح العام إلا إذا كانت البيئة
    # local/staging صريحة. الغياب والخطأ يجب أن يفشلا مغلقاً مثل production.
    for configured_environment in ('production', None, 'prodution'):
        if configured_environment is None:
            os.environ.pop('FATINAH_ENVIRONMENT', None)
        else:
            os.environ['FATINAH_ENVIRONMENT'] = configured_environment
        status, _, body = static_asset('/')
        assert status == 200
        assert b'https://apps.apple.com/app/id6794660419' in body
        assert b'<script' not in body
        for protected_asset in (
            '/app.js', '/app.css', '/question-bank.js',
            '/approved-question-bank.js', '/download/index.html',
            '/www/app.js', '/fatinah_updated.zip',
        ):
            status, _, body = static_asset(protected_asset)
            assert status == 404
            if protected_asset in {
                    '/app.js', '/app.css', '/question-bank.js',
                    '/approved-question-bank.js', '/download/index.html'}:
                assert json.loads(body)['code'] == 'ios_app_only'
        status, _, _ = static_asset('/privacy-policy.html')
        assert status == 200
        status, _, _ = static_asset('/terms-of-service.html')
        assert status == 200
    os.environ['FATINAH_ENVIRONMENT'] = 'local'

    uid = urllib.parse.quote('feature-user')
    status, data = request('GET', f'/api/v2/free-round/status?uid={uid}')
    assert status == 200 and data == {'eligible': True, 'completed': False}

    status, data = request('POST', '/api/v2/free-round/complete', {
        'uid': 'feature-user', 'idToken': 'TEST_ID_TOKEN',
    })
    assert status == 200 and data['completed'] is True
    status, _ = request('POST', '/api/v2/free-round/complete', {
        'uid': 'feature-user', 'idToken': 'TEST_ID_TOKEN',
    })
    assert status == 200
    status, data = request('GET', f'/api/v2/free-round/status?uid={uid}')
    assert status == 200 and data == {'eligible': False, 'completed': True}

    report = {
        'uid': 'feature-user', 'idToken': 'TEST_ID_TOKEN',
        'questionId': 'gq-abcdef1234567890abcd',
        'category': 'القرآن الكريم',
        'question': 'ما اسم السورة الأولى في المصحف؟',
        'answer': 'الفاتحة',
        'sourceTitle': 'تفسير ابن كثير — الفاتحة',
        'sourceUrl': 'https://quran.ksu.edu.sa/tafseer/katheer/sura1.html',
        'reason': 'source',
        'details': 'يرجى تدقيق رابط المصدر.',
        'appVersion': '1.3',
    }
    status, data = request('POST', '/api/v2/questions/report', report)
    assert status == 201 and data['ok'] is True
    assert data['emailStatus'] == 'sent'
    assert 'recipient' not in data
    conn = srv.db_connect()
    try:
        saved_source = conn.execute('''
            SELECT source_title, source_url FROM question_reports
            WHERE report_id=?
        ''', (data['reportId'],)).fetchone()
    finally:
        conn.close()
    assert saved_source == (report['sourceTitle'], report['sourceUrl'])

    status, _ = request('POST', '/api/v2/questions/report', {
        **report, 'sourceUrl': 'http://example.com/insecure',
    })
    assert status == 400

    # غياب SMTP ليس محاولة إرسال. وحتى سجل قديم بلغ الحد بسبب السلوك السابق
    # يجب أن يظل قابلاً للتسليم فور اكتمال الإعداد.
    report_id = data['reportId']
    conn = srv.db_connect()
    try:
        conn.execute('''
            UPDATE question_reports
            SET email_status='pending_configuration', email_attempts=20,
                emailed_at=NULL
            WHERE report_id=?
        ''', (report_id,))
        conn.commit()
    finally:
        conn.close()
    srv._send_question_report_email = lambda _row: 'pending_configuration'
    assert srv.deliver_pending_question_reports(limit=5) == 0
    conn = srv.db_connect()
    try:
        row = conn.execute('''
            SELECT email_status, email_attempts
            FROM question_reports WHERE report_id=?
        ''', (report_id,)).fetchone()
    finally:
        conn.close()
    assert row == ('pending_configuration', 20)

    srv._send_question_report_email = lambda _row: 'sent'
    assert srv.deliver_pending_question_reports(limit=5) == 1
    conn = srv.db_connect()
    try:
        row = conn.execute('''
            SELECT email_status, email_attempts
            FROM question_reports WHERE report_id=?
        ''', (report_id,)).fetchone()
    finally:
        conn.close()
    assert row == ('sent', 21)

    status, _ = request('POST', '/api/v2/questions/report', {**report, 'reason': 'invalid'})
    assert status == 400

    metric = {
        'uid': 'feature-user', 'idToken': 'TEST_ID_TOKEN',
        'eventId': '123e4567-e89b-42d3-a456-426614174000',
        'event': 'game_completed', 'appVersion': '1.3',
        'properties': {'questions': 12, 'correct': 7, 'freeRound': True},
    }
    status, _ = request('POST', '/api/v2/metrics/event', metric)
    assert status == 202
    status, _ = request('POST', '/api/v2/metrics/event', metric)
    assert status == 202
    status, _ = request('POST', '/api/v2/metrics/event', {**metric, 'event': 'arbitrary_event'})
    assert status == 400
    status, _ = request('POST', '/api/v2/metrics/event', {
        **metric,
        'eventId': '223e4567-e89b-42d3-a456-426614174000',
        'properties': {'questions': 12, 'email': 'private@example.com'},
    })
    assert status == 400
    status, _ = request('POST', '/api/v2/metrics/event', {
        **metric,
        'eventId': '323e4567-e89b-42d3-a456-426614174000',
        'properties': {'questions': 999999},
    })
    assert status == 400

    assert raw_status('Content-Length: -1\r\n') == 400
    assert raw_status('Transfer-Encoding: chunked\r\n') == 400

    diagnostic = {
        'uid': 'feature-user', 'idToken': 'TEST_ID_TOKEN',
        'reportId': '123e4567-e89b-42d3-a456-426614174000',
        'reportType': 'metric', 'payload': 'eyJ0ZXN0Ijp0cnVlfQ==',
        'appVersion': '1.3',
    }
    status, data = request('POST', '/api/ios-diagnostics', diagnostic)
    assert status == 202 and data['reportId'] == diagnostic['reportId']

    anonymous_diagnostic = {
        'schemaVersion': 2,
        'privacyScope': 'anonymous',
        'reportId': 'a' * 64,
        'reportType': 'diagnostic',
        'payload': 'eyJ0ZXN0Ijp0cnVlfQ==',
        'appVersion': '1.3 (6)',
    }
    conn = srv.db_connect()
    try:
        conn.execute('''INSERT INTO ios_diagnostics
            (report_id, uid, schema_version, privacy_scope, report_type,
             payload, app_version, created_at)
            VALUES (?, '', 2, 'anonymous', 'metric', 'e30=', '1.3',
                    datetime('now', '-31 days'))''', ('d' * 64,))
        conn.commit()
    finally:
        conn.close()
    durable_records = []
    real_durable_write = srv.durable_write
    srv.durable_write = lambda path, record, *, merge=True: (
        durable_records.append((path, record, merge)) or True)
    try:
        status, data = request(
            'POST', '/api/v2/ios-diagnostics', anonymous_diagnostic,
            token='', extra_headers={'X-Firebase-AppCheck': 'TEST_APP_CHECK'})
    finally:
        srv.durable_write = real_durable_write
    assert status == 202 and data['reportId'] == anonymous_diagnostic['reportId']
    assert durable_records[0][0] == (
        f'ios_diagnostics_anonymous/{anonymous_diagnostic["reportId"]}')
    assert isinstance(durable_records[0][1]['expire_at'], datetime.datetime)
    assert durable_records[0][1]['expire_at'].tzinfo is not None
    conn = srv.db_connect()
    try:
        anonymous_row = conn.execute('''
            SELECT uid, schema_version, privacy_scope
            FROM ios_diagnostics WHERE report_id=?
        ''', (anonymous_diagnostic['reportId'],)).fetchone()
        stale_row = conn.execute(
            'SELECT 1 FROM ios_diagnostics WHERE report_id=?',
            ('d' * 64,),
        ).fetchone()
    finally:
        conn.close()
    assert anonymous_row == ('', 2, 'anonymous')
    assert stale_row is None

    # v2 يرفض ربط MetricKit بأي UID ولو كان الرمز صحيحاً، ويتطلب App Check
    # حتى إذا كانت البيئة العامة في وضع المراقبة.
    status, data = request(
        'POST', '/api/v2/ios-diagnostics', {
            **anonymous_diagnostic,
            'reportId': 'b' * 64,
            'uid': 'feature-user',
            'idToken': 'TEST_ID_TOKEN',
        }, extra_headers={'X-Firebase-AppCheck': 'TEST_APP_CHECK'})
    assert status == 400 and data['code'] == 'diagnostic_identity_forbidden'
    status, data = request(
        'POST', '/api/v2/ios-diagnostics', {
            **anonymous_diagnostic, 'reportId': 'c' * 64,
        }, token='')
    assert status == 401 and data['code'] == 'app_check_required'

    status, data = request('GET', '/api/admin/metrics?days=7', admin=True)
    assert status == 200
    assert data['events']['game_completed'] == 1
    assert data['questionReports']['sent'] == 1

    os.environ['FIREBASE_APP_CHECK_ENFORCE'] = 'true'
    status, data = request('GET', f'/api/free-round/status?uid={uid}')
    assert status == 404 and data.get('code') == 'v2_route_required'
    status, data = request('GET', f'/api/v2/free-round/status?uid={uid}')
    assert status == 401 and data.get('code') == 'app_check_failed'
    os.environ['FIREBASE_APP_CHECK_ENFORCE'] = 'false'
    print('free round, secure reports, email delivery state, and metrics: passed')
finally:
    httpd.shutdown()
    os.unlink(tmp_db.name)
