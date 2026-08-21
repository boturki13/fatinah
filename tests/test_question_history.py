#!/usr/bin/env python3
"""اختبار مزامنة منع تكرار الأسئلة بين أجهزة الحساب نفسه."""
import json
import os
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
os.environ['FATINAH_ENVIRONMENT'] = 'local'
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server as srv

tmp_db = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
tmp_db.close()
srv.DB_PATH = tmp_db.name
srv.init_db()
srv.uid_matches_token = lambda uid, token: uid == 'question-user' and token == 'TEST_ID_TOKEN'

httpd = HTTPServer(('127.0.0.1', 0), srv.Handler)
port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
time.sleep(0.05)
base = f'http://127.0.0.1:{port}'

def request(method, path, payload=None, token='TEST_ID_TOKEN'):
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        base + path,
        data=body,
        method=method,
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {token}',
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())

try:
    uid = urllib.parse.quote('question-user')
    status, result = request('GET', f'/api/v2/questions/seen?uid={uid}')
    assert status == 200 and result['items'] == []

    status, _ = request('POST', '/api/v2/questions/seen', {
        'uid': 'question-user', 'idToken': 'WRONG',
        'items': [{'id': 'q2-alpha', 'category': 'علوم'}],
    }, token='WRONG')
    assert status == 401

    status, _ = request('POST', '/api/v2/questions/seen', {
        'uid': 'question-user', 'idToken': 'TEST_ID_TOKEN',
        'items': [{'id': '../invalid', 'category': 'علوم'}],
    })
    assert status == 400

    payload = {
        'uid': 'question-user', 'idToken': 'TEST_ID_TOKEN',
        'items': [
            {'id': 'q2-alpha', 'category': 'علوم'},
            {'id': 'gq-1234567890abcdefabcd', 'category': 'القرآن الكريم'},
            {'id': 'q2-alpha', 'category': 'علوم'},
        ],
    }
    status, result = request('POST', '/api/v2/questions/seen', payload)
    assert status == 200 and result['saved'] == 2
    status, result = request('POST', '/api/v2/questions/seen', payload)
    assert status == 200 and result['saved'] == 2

    status, result = request('GET', f'/api/v2/questions/seen?uid={uid}')
    assert status == 200
    assert {(item['id'], item['category']) for item in result['items']} == {
        ('q2-alpha', 'علوم'),
        ('gq-1234567890abcdefabcd', 'القرآن الكريم'),
    }
    assert result['bankVersion'] == 3
    print('question history: authenticated, validated, idempotent, and available across devices')
finally:
    httpd.shutdown()
    os.unlink(tmp_db.name)
