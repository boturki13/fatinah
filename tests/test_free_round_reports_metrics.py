#!/usr/bin/env python3
"""تكامل الجولة المجانية وبلاغات الأسئلة ومؤشرات اللعب."""
import gzip
import http.client
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
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server as srv

tmp_db = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
tmp_db.close()
srv.DB_PATH = tmp_db.name
srv.init_db()
srv.uid_matches_token = lambda uid, token: uid == 'feature-user' and token == 'TEST_ID_TOKEN'
srv._send_question_report_email = lambda _row: 'sent'

httpd = HTTPServer(('127.0.0.1', 0), srv.Handler)
port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
time.sleep(0.05)
base = f'http://127.0.0.1:{port}'

def request(method, path, payload=None, token='TEST_ID_TOKEN', admin=False):
    body = json.dumps(payload).encode() if payload is not None else None
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    if admin:
        headers['X-Admin-Secret'] = 'TEST_ADMIN_SECRET'
    req = urllib.request.Request(base + path, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())

def raw_status(extra_headers):
    with socket.create_connection(('127.0.0.1', port), timeout=2) as connection:
        request_bytes = (
            'POST /api/metrics/event HTTP/1.1\r\n'
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

    uid = urllib.parse.quote('feature-user')
    status, data = request('GET', f'/api/free-round/status?uid={uid}')
    assert status == 200 and data == {'eligible': True, 'completed': False}

    status, data = request('POST', '/api/free-round/complete', {
        'uid': 'feature-user', 'idToken': 'TEST_ID_TOKEN',
    })
    assert status == 200 and data['completed'] is True
    status, _ = request('POST', '/api/free-round/complete', {
        'uid': 'feature-user', 'idToken': 'TEST_ID_TOKEN',
    })
    assert status == 200
    status, data = request('GET', f'/api/free-round/status?uid={uid}')
    assert status == 200 and data == {'eligible': False, 'completed': True}

    report = {
        'uid': 'feature-user', 'idToken': 'TEST_ID_TOKEN',
        'questionId': 'gq-abcdef1234567890abcd',
        'category': 'القرآن الكريم',
        'question': 'ما اسم السورة الأولى في المصحف؟',
        'answer': 'الفاتحة',
        'reason': 'source',
        'details': 'يرجى تدقيق رابط المصدر.',
        'appVersion': '1.3',
    }
    status, data = request('POST', '/api/questions/report', report)
    assert status == 201 and data['ok'] is True
    assert data['emailStatus'] == 'sent'
    assert 'recipient' not in data

    status, _ = request('POST', '/api/questions/report', {**report, 'reason': 'invalid'})
    assert status == 400

    metric = {
        'uid': 'feature-user', 'idToken': 'TEST_ID_TOKEN',
        'eventId': '123e4567-e89b-42d3-a456-426614174000',
        'event': 'game_completed', 'appVersion': '1.3',
        'properties': {'questions': 12, 'correct': 7, 'freeRound': True},
    }
    status, _ = request('POST', '/api/metrics/event', metric)
    assert status == 202
    status, _ = request('POST', '/api/metrics/event', metric)
    assert status == 202
    status, _ = request('POST', '/api/metrics/event', {**metric, 'event': 'arbitrary_event'})
    assert status == 400
    status, _ = request('POST', '/api/metrics/event', {
        **metric,
        'eventId': '223e4567-e89b-42d3-a456-426614174000',
        'properties': {'questions': 12, 'email': 'private@example.com'},
    })
    assert status == 400
    status, _ = request('POST', '/api/metrics/event', {
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

    status, data = request('GET', '/api/admin/metrics?days=7', admin=True)
    assert status == 200
    assert data['events']['game_completed'] == 1
    assert data['questionReports']['sent'] == 1

    os.environ['FIREBASE_APP_CHECK_ENFORCE'] = 'true'
    status, data = request('GET', f'/api/free-round/status?uid={uid}')
    assert status == 401 and data.get('code') == 'app_check_failed'
    os.environ['FIREBASE_APP_CHECK_ENFORCE'] = 'false'
    print('free round, secure reports, email delivery state, and metrics: passed')
finally:
    httpd.shutdown()
    os.unlink(tmp_db.name)
