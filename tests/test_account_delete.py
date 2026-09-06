#!/usr/bin/env python3
"""اختبار حذف الحساب من SQLite وFirestore معاً دون لمس بيانات الإنتاج."""
import json
import os
import sqlite3
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import HTTPServer

os.environ['FIREBASE_PROJECT_ID'] = 'test-project'
os.environ['GOOGLE_API_KEY'] = ''
os.environ['FIREBASE_SERVICE_ACCOUNT_JSON'] = '{"project_id":"test-project"}'
os.environ['FIREBASE_SERVICE_ACCOUNT'] = ''
os.environ['FATINAH_DURABLE_STORAGE'] = 'off'

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server as srv

tmp_db = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
tmp_db.close()
srv.DB_PATH = tmp_db.name
srv.init_db()
srv.init_outbox_table()

# هذه الجداول تُنشأ أثناء تشغيل التطبيق/ترحيل البيانات، وليست ضمن init_db()
# الأساسي في بيئة الاختبار الجديدة. ننشئ نسخة مصغّرة من مخططها هنا فقط.
with sqlite3.connect(tmp_db.name) as schema_conn:
    schema_conn.executescript("""
        CREATE TABLE IF NOT EXISTS archived_stats (
            uid TEXT NOT NULL,
            games INTEGER NOT NULL DEFAULT 0,
            correct INTEGER NOT NULL DEFAULT 0,
            total_q INTEGER NOT NULL DEFAULT 0,
            best_score INTEGER NOT NULL DEFAULT 0,
            wins INTEGER NOT NULL DEFAULT 0,
            ach TEXT NOT NULL DEFAULT '{}',
            archived_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS family_categories (
            uid TEXT NOT NULL,
            name TEXT NOT NULL,
            questions TEXT NOT NULL DEFAULT '[]',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS player_stats (
            uid TEXT PRIMARY KEY,
            games INTEGER NOT NULL DEFAULT 0,
            correct INTEGER NOT NULL DEFAULT 0,
            total_q INTEGER NOT NULL DEFAULT 0,
            best_score INTEGER NOT NULL DEFAULT 0,
            wins INTEGER NOT NULL DEFAULT 0,
            ach TEXT NOT NULL DEFAULT '{}',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS seen_questions (
            uid TEXT NOT NULL,
            topic_norm TEXT NOT NULL,
            q_ids TEXT NOT NULL DEFAULT '[]',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    """)

def fake_verify_id_token(token):
    claims = {
        'TEST_ID_TOKEN': {
            'localId': 'uid-delete-test',
            'authTime': int(time.time()),
            'signInProvider': 'password',
        },
        'OLD_ID_TOKEN': {
            'localId': 'uid-delete-test',
            'authTime': int(time.time()) - 3600,
            'signInProvider': 'apple.com',
        },
        'MISSING_AUTH_TIME_TOKEN': {
            'localId': 'uid-delete-test',
            'signInProvider': 'google.com',
        },
    }
    return claims.get(token)

srv.verify_firebase_id_token = fake_verify_id_token

firestore_calls = []
firestore_should_fail = False

def fake_firestore_delete(uid):
    firestore_calls.append(uid)
    if firestore_should_fail:
        raise RuntimeError('simulated Firestore failure')

srv.firestore_delete_subscription = fake_firestore_delete

httpd = HTTPServer(('127.0.0.1', 0), srv.Handler)
port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()
time.sleep(0.05)
base = f'http://127.0.0.1:{port}'

uid = 'uid-delete-test'

def seed_user():
    conn = sqlite3.connect(tmp_db.name)
    # يحاكي جدولاً متبقياً من إصدارات الأكواد القديمة؛ الخادم الجديد لا ينشئه،
    # لكن حذف الحساب يجب أن ينظفه إذا وُجد في قاعدة بيانات تمت ترقيتها.
    conn.execute('''
        CREATE TABLE IF NOT EXISTS promo_redemptions (
            uid TEXT NOT NULL,
            code TEXT NOT NULL,
            expires_at DATETIME NOT NULL,
            PRIMARY KEY (uid, code)
        )
    ''')
    conn.execute(
        "INSERT INTO subscriptions (uid, status) VALUES (?, 'active')", (uid,)
    )
    conn.execute(
        "INSERT INTO promo_redemptions (uid, code, expires_at) "
        "VALUES (?, 'TEST', '2099-01-01')", (uid,)
    )
    conn.execute(
        "INSERT INTO revenuecat_identities (uid, rc_app_user_id) "
        "VALUES (?, ?)", (uid, '11111111-1111-4111-8111-111111111111')
    )
    conn.execute('''
        INSERT INTO revenuecat_events
        (event_id, event_type, uid, status, payload, rc_ids)
        VALUES (?, 'TRANSFER', '', 'processed', '{}', ?)
    ''', (
        'account-delete-transfer-event',
        '["11111111-1111-4111-8111-111111111111"]',
    ))
    for table, values in (
        ('archived_stats', (uid, 1, 1, 1, 10, 1, '{}')),
        ('family_categories', (uid, 'عائلية', '[]')),
        ('player_stats', (uid, 1, 1, 1, 10, 1, '{}')),
        ('seen_questions', (uid, 'رياضة', '[]')),
    ):
        conn.execute(
            f'INSERT INTO "{table}" '
            f'({", ".join(["uid"] + (["name", "questions"] if table == "family_categories" else ["games", "correct", "total_q", "best_score", "wins", "ach"] if table in ("archived_stats", "player_stats") else ["topic_norm", "q_ids"]))}) '
            f'VALUES ({",".join("?" for _ in values)})',
            values,
        )
    conn.execute(
        "INSERT INTO subscription_outbox (uid, payload) VALUES (?, '{}')", (uid,)
    )
    conn.execute(
        "INSERT INTO question_seen (uid, question_id, category) VALUES (?, ?, ?)",
        (uid, 'q2-account-delete', 'علوم')
    )
    conn.commit()
    conn.close()

def post_delete(token='TEST_ID_TOKEN'):
    payload = json.dumps({'uid': uid, 'idToken': token}).encode()
    req = urllib.request.Request(
        base + '/api/account/delete',
        data=payload,
        method='POST',
        headers={'Content-Type': 'application/json'},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def post_json(path, payload):
    req = urllib.request.Request(
        base + path,
        data=json.dumps(payload).encode(),
        method='POST',
        headers={'Content-Type': 'application/json'},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())

def user_rows():
    conn = sqlite3.connect(tmp_db.name)
    rows = {}
    for table in (
        'subscriptions', 'promo_redemptions', 'revenuecat_identities',
        'revenuecat_events',
        'archived_stats', 'family_categories', 'player_stats',
        'seen_questions', 'subscription_outbox',
        'question_seen',
    ):
        if table == 'revenuecat_events':
            rows[table] = conn.execute(
                'SELECT COUNT(*) FROM revenuecat_events '
                'WHERE uid=? OR rc_ids LIKE ?',
                (uid, '%"11111111-1111-4111-8111-111111111111"%'),
            ).fetchone()[0]
        else:
            rows[table] = conn.execute(
                f'SELECT COUNT(*) FROM "{table}" WHERE uid=?', (uid,)
            ).fetchone()[0]
    conn.close()
    return rows

try:
    seed_user()
    status, body = post_delete('OLD_ID_TOKEN')
    assert status == 401 and body.get('code') == 'recent_auth_required', body
    assert all(value == 1 for value in user_rows().values()), user_rows()

    status, body = post_delete('MISSING_AUTH_TIME_TOKEN')
    assert status == 401 and body.get('code') == 'recent_auth_required', body
    assert all(value == 1 for value in user_rows().values()), user_rows()

    status, body = post_delete('')
    assert status == 401 and body.get('code') == 'invalid_auth_token', body
    assert all(value == 1 for value in user_rows().values()), user_rows()

    firestore_should_fail = True
    status, body = post_delete()
    assert status == 503 and body.get('ok') is not True
    assert all(value == 1 for value in user_rows().values()), user_rows()

    firestore_should_fail = False
    status, body = post_delete()
    assert status == 200 and body.get('ok') is True
    assert all(value == 0 for value in user_rows().values()), user_rows()
    assert firestore_calls == [uid, uid], firestore_calls

    canonical_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    legacy_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    identity_calls = []
    srv.local_revenuecat_identity = lambda _uid: None
    srv.claim_firestore_revenuecat_identity = lambda bound_uid, **kwargs: (
        identity_calls.append(('v2', bound_uid, kwargs)) or canonical_id)
    def fake_v1_claim(bound_uid, claimed_id, *, allow_bootstrap):
        identity_calls.append(
            ('v1', bound_uid, claimed_id, allow_bootstrap))
        if not allow_bootstrap:
            raise srv.RevenueCatV1BootstrapDisabledError('upgrade required')
        return claimed_id
    srv.claim_v1_firestore_revenuecat_identity = fake_v1_claim
    cache_calls = []
    def failing_identity_cache(bound_uid, claimed_id, **kwargs):
        cache_calls.append((bound_uid, claimed_id, kwargs))
        raise sqlite3.OperationalError('simulated stale cache lock')
    srv.cache_revenuecat_identity = failing_identity_cache
    srv.replay_pending_revenuecat_events = lambda _rc_id: 2

    status, response = post_json('/api/v2/revenuecat/identity', {
        'uid': uid,
        'idToken': 'TEST_ID_TOKEN',
        'legacyRcAppUserId': legacy_id,
    })
    assert status == 200 and response == {
        'ok': True, 'rcAppUserId': canonical_id, 'replayed': 2,
    }, response
    assert identity_calls[-1] == (
        'v2', uid, {'legacy_hint': legacy_id, 'trusted_local_id': ''})
    assert cache_calls[-1] == (
        uid, canonical_id, {'authoritative': True})

    # Keep this HTTP integration isolated from production's distributed rate
    # limiter; the unit test above separately proves production defaults false.
    os.environ['FATINAH_ENVIRONMENT'] = 'staging'
    os.environ['FATINAH_V1_REVENUECAT_BOOTSTRAP_ENABLED'] = 'false'
    status, response = post_json('/api/revenuecat/identity', {
        'uid': uid,
        'idToken': 'TEST_ID_TOKEN',
        'rcAppUserId': legacy_id,
    })
    assert status == 426, response
    assert response.get('code') == 'revenuecat_v2_upgrade_required', response
    assert identity_calls[-1] == ('v1', uid, legacy_id, False)

    os.environ['FATINAH_V1_REVENUECAT_BOOTSTRAP_ENABLED'] = 'true'
    status, response = post_json('/api/revenuecat/identity', {
        'uid': uid,
        'idToken': 'TEST_ID_TOKEN',
        'rcAppUserId': legacy_id,
    })
    assert status == 200 and response == {
        'ok': True, 'rcAppUserId': legacy_id, 'replayed': 2,
    }, response
    assert identity_calls[-1] == ('v1', uid, legacy_id, True)
    assert cache_calls[-1] == (uid, legacy_id, {'authoritative': True})
    print('account delete: fresh auth required; Firestore failure rolls back; success removes all rows')
finally:
    httpd.shutdown()
    os.unlink(tmp_db.name)
