#!/usr/bin/env python3
"""DeviceCheck يجعل الجولة المجانية مرة واحدة للجهاز ويفشل مغلقاً."""
import json
import os
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ['FATINAH_ENVIRONMENT'] = 'local'
os.environ['FATINAH_V2_DEVICECHECK_ENFORCE'] = 'true'
os.environ['FATINAH_V2_FEATURE_FREE_ROUND_ENABLED'] = 'true'
os.environ['FATINAH_V2_APP_CHECK_ENFORCE'] = 'false'
sys.path.insert(0, str(ROOT))
import server as srv

tmp_db = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
tmp_db.close()
srv.DB_PATH = tmp_db.name
srv.init_db()
srv.uid_matches_token = lambda uid, token: token == f'token-{uid}'

device_state = {'claimed': False, 'fail': False}
apple_calls = []


def fake_devicecheck(operation, token, *, bit0=None, bit1=None):
    if device_state['fail']:
        raise srv.DeviceCheckServiceError('offline')
    apple_calls.append((operation, token, bit0, bit1))
    if operation == 'query_two_bits':
        return {'bit0': device_state['claimed'], 'bit1': False}
    assert operation == 'update_two_bits'
    assert bit0 is True
    device_state['claimed'] = True
    return {}


srv.devicecheck_request = fake_devicecheck
httpd = srv.ThreadedHTTPServer(('127.0.0.1', 0), srv.Handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
time.sleep(0.05)
base = f'http://127.0.0.1:{httpd.server_address[1]}'


def request(method, path, payload=None, *, uid='account-a', device_token=''):
    headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer token-{uid}',
        'X-Fatinah-API-Version': '2',
    }
    if device_token:
        headers['X-DeviceCheck-Token'] = device_token
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(base + path, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, json.loads(response.read() or b'{}')
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b'{}')


try:
    status, data = request('GET', '/api/v2/free-round/status?uid=account-a')
    assert status == 401 and data['code'] == 'device_check_missing'

    status, data = request(
        'GET', '/api/v2/free-round/status?uid=account-a', device_token='query-a-1')
    assert status == 200 and data == {'eligible': True, 'completed': False}

    status, data = request('POST', '/api/v2/free-round/complete', {
        'uid': 'account-a',
        'idToken': 'token-account-a',
        'deviceCheckToken': 'query-a-2',
        'deviceCheckUpdateToken': 'update-a-1',
    })
    assert status == 200 and data['completed'] is True
    assert apple_calls[-2][0:2] == ('query_two_bits', 'query-a-2')
    assert apple_calls[-1][0:2] == ('update_two_bits', 'update-a-1')
    assert apple_calls[-2][1] != apple_calls[-1][1]

    # تسجيل خروج A ثم UID جديد B على الجهاز نفسه لا يعيد المنحة.
    status, data = request(
        'GET', '/api/v2/free-round/status?uid=account-b',
        uid='account-b', device_token='query-b-1')
    assert status == 200 and data == {'eligible': False, 'completed': True}
    status, data = request('POST', '/api/v2/free-round/complete', {
        'uid': 'account-b',
        'idToken': 'token-account-b',
        'deviceCheckToken': 'query-b-2',
        'deviceCheckUpdateToken': 'update-b-1',
    }, uid='account-b')
    assert status == 409 and data['code'] == 'free_round_already_claimed'

    # انقطاع Apple لا يتحول إلى eligible=true.
    device_state['fail'] = True
    status, data = request(
        'GET', '/api/v2/free-round/status?uid=account-c',
        uid='account-c', device_token='query-c-1')
    assert status == 503 and data['code'] == 'device_check_unavailable'

    # طلبان متزامنان لحسابين على الجهاز نفسه: القفل يحيط query→update، لذلك
    # لا يصل إلى Apple سوى تحديث واحد ولا يحصل الحسابان على الجولة معاً.
    device_state.update({'claimed': False, 'fail': False})
    apple_calls.clear()
    conn = srv.db_connect()
    try:
        conn.execute('DELETE FROM free_rounds')
        conn.commit()
    finally:
        conn.close()
    start = threading.Barrier(3)
    results = []

    def concurrent_claim(uid):
        start.wait(timeout=5)
        results.append(request('POST', '/api/v2/free-round/complete', {
            'uid': uid,
            'idToken': f'token-{uid}',
            'deviceCheckToken': f'query-{uid}',
            'deviceCheckUpdateToken': f'update-{uid}',
        }, uid=uid))

    workers = [
        threading.Thread(target=concurrent_claim, args=('account-x',)),
        threading.Thread(target=concurrent_claim, args=('account-y',)),
    ]
    for worker in workers: worker.start()
    start.wait(timeout=5)
    for worker in workers: worker.join(timeout=5)
    assert all(not worker.is_alive() for worker in workers)
    assert sorted(status for status, _ in results) == [200, 409], results
    assert sum(call[0] == 'update_two_bits' for call in apple_calls) == 1

    # استرجاع lease منتهي يعتمد updateTime ويحرره بشرط النسخة نفسها.
    real_available = srv.firestore_durable_available
    real_create = srv.firestore_create_document_if_absent
    real_get = srv.firestore_get_document
    real_delete = srv.firestore_delete_document_if_update_time
    create_results = iter([None, 'fresh-update-time'])
    conditional_deletes = []
    srv.firestore_durable_available = lambda: True
    srv.firestore_create_document_if_absent = lambda path, data: next(create_results)
    srv.firestore_get_document = lambda path: {
        'expires_at': int(time.time()) - 1,
        '_update_time': 'stale-update-time',
    }
    srv.firestore_delete_document_if_update_time = (
        lambda path, update_time: conditional_deletes.append(update_time) or True
    )
    try:
        handle = srv.acquire_devicecheck_claim_guard()
        assert handle == {
            'distributed': True,
            'update_time': 'fresh-update-time',
        }
        srv.release_devicecheck_claim_guard(handle)
        assert conditional_deletes == [
            'stale-update-time', 'fresh-update-time',
        ]
    finally:
        srv.firestore_durable_available = real_available
        srv.firestore_create_document_if_absent = real_create
        srv.firestore_get_document = real_get
        srv.firestore_delete_document_if_update_time = real_delete

    print('DeviceCheck identity, CORS-safe locking, and fail-closed behavior: passed')
finally:
    httpd.shutdown()
    os.unlink(tmp_db.name)
