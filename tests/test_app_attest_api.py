#!/usr/bin/env python3
"""عقد App Attest في v2 وربطه الذري بمطالبة الجولة المجانية."""

import base64
import json
import os
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
os.environ.update({
    'FATINAH_ENVIRONMENT': 'local',
    'FATINAH_V2_APP_CHECK_ENFORCE': 'true',
    'FATINAH_V2_APP_ATTEST_ENFORCE': 'true',
    'FATINAH_V2_DEVICECHECK_ENFORCE': 'true',
    'FATINAH_V2_FEATURE_APP_ATTEST_ENABLED': 'true',
    'FATINAH_V2_FEATURE_FREE_ROUND_ENABLED': 'true',
    'APPLE_APP_ATTEST_APP_ID_PREFIX': 'A787MTL6U4',
    'APPLE_APP_ATTEST_BUNDLE_ID': 'com.fatinah.game',
    'APPLE_DEVICECHECK_ENVIRONMENT': 'development',
    'FIREBASE_PROJECT_ID': 'test-project',
    'FATINAH_DURABLE_STORAGE': 'off',
})
sys.path.insert(0, str(ROOT))
import server as srv

tmp_db = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
tmp_db.close()
srv.DB_PATH = tmp_db.name
srv.init_db()
srv.uid_matches_token = lambda uid, token: token == f'token-{uid}'
srv.verify_app_check_header = lambda headers, _path: (
    headers.get('X-Firebase-AppCheck') == 'APP_CHECK',
    'verified',
)

key_id = base64.b64encode(bytes(range(32))).decode('ascii')
device_state = {'claimed': False}
apple_calls = []


def fake_devicecheck(operation, token, *, bit0=None, bit1=None):
    apple_calls.append((operation, token, bit0, bit1))
    if operation == 'query_two_bits':
        return {'bit0': device_state['claimed'], 'bit1': False}
    assert operation == 'update_two_bits' and bit0 is True
    device_state['claimed'] = True
    return {}


def fake_attestation(*, uid, key_id, challenge_id, attestation_object):
    assert attestation_object == 'synthetic-attestation'
    challenge = srv.get_app_attest_challenge(
        challenge_id, uid=uid, key_id=key_id, purpose='attest')
    srv.store_app_attest_key(
        key_id,
        SimpleNamespace(public_key_pem=b'PUBLIC KEY', receipt=b'receipt'),
        'development',
    )
    srv.consume_app_attest_challenge(challenge)


def fake_assertion(*, uid, key_id, challenge_id, assertion, purpose,
                   request_hash=''):
    assert assertion == 'synthetic-assertion'
    challenge = srv.get_app_attest_challenge(
        challenge_id, uid=uid, key_id=key_id, purpose=purpose,
        request_hash=request_hash)
    srv.consume_app_attest_challenge(challenge)


srv.devicecheck_request = fake_devicecheck
srv.verify_app_attest_attestation = fake_attestation
srv.verify_app_attest_assertion = fake_assertion

httpd = srv.ThreadedHTTPServer(('127.0.0.1', 0), srv.Handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
time.sleep(0.05)
base = f'http://127.0.0.1:{httpd.server_address[1]}'


def request(method, path, payload=None, *, uid='account-a', headers=None):
    request_headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer token-{uid}',
        'X-Firebase-AppCheck': 'APP_CHECK',
        'X-Fatinah-API-Version': '2',
    }
    request_headers.update(headers or {})
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        base + path, data=body, method=method, headers=request_headers)
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, dict(response.headers), json.loads(
                response.read() or b'{}')
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers), json.loads(
            error.read() or b'{}')


def challenge(uid, purpose, request_hash=''):
    status, _, data = request('POST', '/api/v2/app-attest/challenge', {
        'uid': uid,
        'idToken': f'token-{uid}',
        'keyId': key_id,
        'purpose': purpose,
        'requestHash': request_hash,
    }, uid=uid)
    assert status == 201
    return data


try:
    status, _, data = request('POST', '/api/v2/app-attest/status', {
        'uid': 'account-a', 'idToken': 'token-account-a', 'keyId': key_id,
    })
    assert status == 200 and data == {'attested': False}

    enrollment = challenge('account-a', 'attest')
    decoded_client_data = base64.b64decode(enrollment['clientData']).decode()
    assert 'account-a' not in decoded_client_data
    assert 'uidHash' in decoded_client_data
    conn = srv.db_connect()
    try:
        stored_uid_hash = conn.execute(
            'SELECT uid_hash FROM app_attest_challenges WHERE challenge_id=?',
            (enrollment['challengeId'],),
        ).fetchone()[0]
    finally:
        conn.close()
    assert stored_uid_hash == srv._app_attest_uid_hash('account-a')
    assert stored_uid_hash != 'account-a'
    status, _, data = request('POST', '/api/v2/app-attest/attest', {
        'uid': 'account-a',
        'idToken': 'token-account-a',
        'keyId': key_id,
        'challengeId': enrollment['challengeId'],
        'attestationObject': 'synthetic-attestation',
    })
    assert status == 201 and data == {'attested': True}

    status_token = 'status-device-token'
    status_hash = srv.free_round_app_attest_request_hash(
        'account-a', status_token)
    proof = challenge('account-a', 'free_round_status', status_hash)
    proof_headers = {
        'X-DeviceCheck-Token': status_token,
        'X-App-Attest-Key-Id': key_id,
        'X-App-Attest-Challenge-Id': proof['challengeId'],
        'X-App-Attest-Assertion': 'synthetic-assertion',
        'X-App-Attest-Request-Hash': status_hash,
    }
    status, _, data = request(
        'GET', '/api/v2/free-round/status?uid=account-a',
        headers=proof_headers)
    assert status == 200 and data == {'eligible': True, 'completed': False}

    # البصمة تربط assertion بالطلب الفعلي؛ تغيير DeviceCheck token مرفوض
    # قبل الوصول إلى Apple أو التحقق الاصطناعي.
    mismatch = challenge('account-a', 'free_round_status', status_hash)
    mismatch_headers = {
        **proof_headers,
        'X-DeviceCheck-Token': 'swapped-device-token',
        'X-App-Attest-Challenge-Id': mismatch['challengeId'],
    }
    status, _, data = request(
        'GET', '/api/v2/free-round/status?uid=account-a',
        headers=mismatch_headers)
    assert status == 401 and data['code'] == 'app_attest_context_mismatch'

    query_token = 'claim-query-token'
    update_token = 'claim-update-token'
    claim_hash = srv.free_round_app_attest_request_hash(
        'account-a', query_token, update_token)
    claim_proof = challenge('account-a', 'free_round_complete', claim_hash)
    assert not srv.app_attest_installation_claim(key_id)
    real_persist_completion = srv.persist_free_round_completion
    persist_attempts = {'count': 0}

    def fail_first_persistence(uid):
        persist_attempts['count'] += 1
        if persist_attempts['count'] == 1:
            raise RuntimeError('synthetic Firestore outage after Apple update')
        return real_persist_completion(uid)

    srv.persist_free_round_completion = fail_first_persistence
    status, _, data = request('POST', '/api/v2/free-round/complete', {
        'uid': 'account-a',
        'idToken': 'token-account-a',
        'deviceCheckToken': query_token,
        'deviceCheckUpdateToken': update_token,
        'appAttestKeyId': key_id,
        'appAttestChallengeId': claim_proof['challengeId'],
        'appAttestAssertion': 'synthetic-assertion',
        'appAttestRequestHash': claim_hash,
    })
    assert status == 503, (status, data)
    assert data['code'] == 'free_round_claim_persistence_failed'
    assert [call[0] for call in apple_calls[-2:]] == [
        'query_two_bits', 'update_two_bits']
    pending_claim = srv.app_attest_installation_claim(key_id)
    assert pending_claim['state'] == 'pending'
    assert len(pending_claim['owner_hash']) == 64
    assert 'account-a' not in json.dumps(pending_claim)
    conn = srv.db_connect()
    try:
        assert not conn.execute(
            'SELECT 1 FROM free_rounds WHERE uid=?', ('account-a',)).fetchone()
    finally:
        conn.close()

    # حتى أثناء pending لا يستطيع حساب ثانٍ الاستحواذ على التثبيت، ولا يصل
    # طلبه إلى Apple.
    apple_call_count = len(apple_calls)
    second_hash = srv.free_round_app_attest_request_hash(
        'account-b', 'second-query', 'second-update')
    second_proof = challenge('account-b', 'free_round_complete', second_hash)
    status, _, data = request('POST', '/api/v2/free-round/complete', {
        'uid': 'account-b',
        'idToken': 'token-account-b',
        'deviceCheckToken': 'second-query',
        'deviceCheckUpdateToken': 'second-update',
        'appAttestKeyId': key_id,
        'appAttestChallengeId': second_proof['challengeId'],
        'appAttestAssertion': 'synthetic-assertion',
        'appAttestRequestHash': second_hash,
    }, uid='account-b')
    assert status == 409
    assert data['code'] == 'free_round_installation_already_claimed'
    assert len(apple_calls) == apple_call_count

    # الحساب الأصلي يعيد الطلب بتحدٍ ورموز DeviceCheck جديدة. bit0 صار true
    # لدى Apple، لكن pending ذات بصمة المالك تسمح بإصلاح UID وإكمال المطالبة.
    retry_hash = srv.free_round_app_attest_request_hash(
        'account-a', 'retry-query', 'retry-update')
    retry_proof = challenge('account-a', 'free_round_complete', retry_hash)
    status, _, data = request('POST', '/api/v2/free-round/complete', {
        'uid': 'account-a',
        'idToken': 'token-account-a',
        'deviceCheckToken': 'retry-query',
        'deviceCheckUpdateToken': 'retry-update',
        'appAttestKeyId': key_id,
        'appAttestChallengeId': retry_proof['challengeId'],
        'appAttestAssertion': 'synthetic-assertion',
        'appAttestRequestHash': retry_hash,
    })
    assert status == 200 and data == {
        'ok': True, 'completed': True, 'alreadyClaimed': True,
    }, (status, data)
    assert sum(call[0] == 'update_two_bits' for call in apple_calls) == 1
    completed_claim = srv.app_attest_installation_claim(key_id)
    assert completed_claim['state'] == 'completed'
    assert completed_claim['owner_hash'] == pending_claim['owner_hash']
    conn = srv.db_connect()
    try:
        assert conn.execute(
            'SELECT 1 FROM free_rounds WHERE uid=?', ('account-a',)).fetchone()
    finally:
        conn.close()

    srv.persist_free_round_completion = real_persist_completion

    # فشل حذف challenge المشروط في Firestore يصنف كفشل تخزين، ويُحوّله
    # endpoint إلى 503 منظّم بدلاً من RuntimeError يغلق اتصال HTTP.
    real_firestore_available = srv.firestore_durable_available
    real_conditional_delete = srv.firestore_delete_document_if_update_time
    real_assertion_verifier = srv.verify_app_attest_assertion
    srv.firestore_durable_available = lambda: True

    def failing_conditional_delete(_path, _update_time):
        raise RuntimeError('synthetic Firestore delete outage')

    def assertion_with_storage_failure(**_kwargs):
        srv.consume_app_attest_challenge({
            'challenge_id': 'A' * 24,
            '_update_time': 'synthetic-update-time',
        })

    srv.firestore_delete_document_if_update_time = failing_conditional_delete
    srv.verify_app_attest_assertion = assertion_with_storage_failure
    try:
        failure_token = 'storage-failure-token'
        failure_hash = srv.free_round_app_attest_request_hash(
            'account-c', failure_token)
        status, _, data = request(
            'GET', '/api/v2/free-round/status?uid=account-c',
            uid='account-c',
            headers={
                'X-DeviceCheck-Token': failure_token,
                'X-App-Attest-Key-Id': key_id,
                'X-App-Attest-Challenge-Id': 'A' * 24,
                'X-App-Attest-Assertion': 'synthetic-assertion',
                'X-App-Attest-Request-Hash': failure_hash,
            })
        assert status == 503 and data['code'] == 'app_attest_unavailable'
    finally:
        srv.verify_app_attest_assertion = real_assertion_verifier
        srv.firestore_delete_document_if_update_time = real_conditional_delete
        srv.firestore_durable_available = real_firestore_available

    # عقد Firestore نفسه: createDocument يحجز ذرياً، owner_hash يمنع حساباً
    # آخر، وPATCH المشروط فقط هو الذي ينقل pending إلى completed.
    firestore_documents = {}
    firestore_clock = {'value': 0}
    real_create_document = srv.firestore_create_document_if_absent
    real_get_document = srv.firestore_get_document
    real_conditional_set = srv.firestore_set_document_if_update_time
    srv.firestore_durable_available = lambda: True

    def fake_create_document(path, fields):
        if path in firestore_documents:
            return None
        firestore_clock['value'] += 1
        update_time = f"update-{firestore_clock['value']}"
        firestore_documents[path] = {**fields, '_update_time': update_time}
        return update_time

    def fake_get_document(path):
        document = firestore_documents.get(path)
        return None if document is None else dict(document)

    def fake_conditional_set(path, fields, update_time):
        document = firestore_documents.get(path)
        if not document or document.get('_update_time') != update_time:
            return False
        firestore_clock['value'] += 1
        firestore_documents[path] = {
            **document, **fields,
            '_update_time': f"update-{firestore_clock['value']}",
        }
        return True

    srv.firestore_create_document_if_absent = fake_create_document
    srv.firestore_get_document = fake_get_document
    srv.firestore_set_document_if_update_time = fake_conditional_set
    firestore_key_id = base64.b64encode(bytes(reversed(range(32)))).decode('ascii')
    try:
        assert srv.reserve_app_attest_installation_claim(
            firestore_key_id, 'owner-a') == 'created_pending'
        assert srv.reserve_app_attest_installation_claim(
            firestore_key_id, 'owner-b') == 'conflict'
        claim = srv.app_attest_installation_claim(firestore_key_id)
        assert claim['state'] == 'pending'
        assert 'owner-a' not in json.dumps(claim)
        srv.complete_app_attest_installation_claim(
            firestore_key_id, 'owner-a')
        assert srv.app_attest_installation_claim_access(
            firestore_key_id, 'owner-a') == 'owned_completed'
        assert srv.app_attest_installation_claim_access(
            firestore_key_id, 'owner-b') == 'conflict'
    finally:
        srv.firestore_set_document_if_update_time = real_conditional_set
        srv.firestore_get_document = real_get_document
        srv.firestore_create_document_if_absent = real_create_document
        srv.firestore_durable_available = real_firestore_available

    status, headers, _ = request('OPTIONS', '/api/v2/free-round/status')
    assert status == 204
    allowed = headers.get('Access-Control-Allow-Headers', '').lower()
    assert 'x-app-attest-assertion' in allowed
    assert 'x-app-attest-key-id' in allowed

    print('App Attest v2 enrollment, request binding, and installation claim: passed')
finally:
    httpd.shutdown()
    os.unlink(tmp_db.name)
