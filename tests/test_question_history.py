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
os.environ['FATINAH_DURABLE_STORAGE'] = 'off'
os.environ['FATINAH_V2_APP_CHECK_ENFORCE'] = 'false'
os.environ['FATINAH_V2_APP_ATTEST_ENFORCE'] = 'false'
os.environ['FATINAH_V2_DEVICECHECK_ENFORCE'] = 'false'
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

    # حجز أسئلة الجولة يمنع خادماً أو جهازاً آخر من اختيارها، لكنه لا يعني
    # أن اللاعب شاهدها. يجب ألا يعيد GET الحجوزات إلى العميل كسجل مشاهدة.
    srv.reserve_question_round('question-user', {
        'علوم': [{'id': 'gq-aaaaaaaaaaaaaaaaaaaa'}],
    })
    assert 'gq-aaaaaaaaaaaaaaaaaaaa' in srv.load_all_question_seen_ids(
        'question-user')
    status, result = request('GET', f'/api/v2/questions/seen?uid={uid}')
    assert status == 200 and result['items'] == []

    # عندما يعرض العميل السؤال فعلياً يتحول الحجز إلى مشاهدة عادية.
    status, result = request('POST', '/api/v2/questions/seen', {
        'uid': 'question-user', 'idToken': 'TEST_ID_TOKEN',
        'items': [{'id': 'gq-aaaaaaaaaaaaaaaaaaaa', 'category': 'علوم'}],
    })
    assert status == 200 and result['saved'] == 1
    status, result = request('GET', f'/api/v2/questions/seen?uid={uid}')
    assert status == 200
    assert [item['id'] for item in result['items']] == [
        'gq-aaaaaaaaaaaaaaaaaaaa']

    # نهاية الجولة تحرر الاحتياطي فقط، ولا تمس السؤال الذي فُتح فعلياً.
    srv.reserve_question_round('question-user', {
        'علوم': [{'id': 'gq-bbbbbbbbbbbbbbbbbbbb'}],
    })
    status, result = request(
        'POST', '/api/v2/questions/reservations/release', {
            'uid': 'question-user', 'idToken': 'TEST_ID_TOKEN',
            'questionIds': [
                'gq-aaaaaaaaaaaaaaaaaaaa',
                'gq-bbbbbbbbbbbbbbbbbbbb',
            ],
        })
    assert status == 200 and result['released'] == 1
    assert srv.load_all_question_seen_ids('question-user') == {
        'gq-aaaaaaaaaaaaaaaaaaaa'}

    # إذا أُغلق التطبيق ولم يصل طلب التحرير، تنتهي الحجوزات القديمة تلقائياً
    # ولا تتحول إلى استهلاك دائم للمخزون.
    expired_id = 'gq-eeeeeeeeeeeeeeeeeeee'
    srv.reserve_question_round('question-user', {
        'علوم': [{'id': expired_id}],
    })
    conn = srv.db_connect()
    try:
        conn.execute('''
            UPDATE question_seen SET reserved_until_epoch=?
            WHERE uid='question-user' AND question_id=?
        ''', (int(time.time()) - 1, expired_id))
        conn.commit()
    finally:
        conn.close()
    assert expired_id not in srv.load_all_question_seen_ids('question-user')

    status, _ = request(
        'POST', '/api/v2/questions/reservations/release', {
            'uid': 'question-user', 'idToken': 'WRONG',
            'questionIds': ['gq-bbbbbbbbbbbbbbbbbbbb'],
        }, token='WRONG')
    assert status == 401

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
        ('gq-aaaaaaaaaaaaaaaaaaaa', 'علوم'),
        ('q2-alpha', 'علوم'),
        ('gq-1234567890abcdefabcd', 'القرآن الكريم'),
    }
    assert result['bankVersion'] == 3
    print('question history: authenticated, validated, idempotent, and available across devices')
finally:
    httpd.shutdown()
    os.unlink(tmp_db.name)
