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
os.environ['FIREBASE_SERVICE_ACCOUNT_JSON'] = ''
os.environ['FIREBASE_SERVICE_ACCOUNT'] = ''

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

srv.uid_matches_token = lambda uid, token: (
    uid == 'uid-delete-test' and token == 'TEST_ID_TOKEN'
)

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
    conn.commit()
    conn.close()

def post_delete():
    payload = json.dumps({'uid': uid, 'idToken': 'TEST_ID_TOKEN'}).encode()
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

def user_rows():
    conn = sqlite3.connect(tmp_db.name)
    rows = {}
    for table in (
        'subscriptions', 'promo_redemptions', 'revenuecat_identities',
        'archived_stats', 'family_categories', 'player_stats',
        'seen_questions', 'subscription_outbox',
    ):
        rows[table] = conn.execute(
            f'SELECT COUNT(*) FROM "{table}" WHERE uid=?', (uid,)
        ).fetchone()[0]
    conn.close()
    return rows

try:
    seed_user()
    firestore_should_fail = True
    status, body = post_delete()
    assert status == 503 and body.get('ok') is not True
    assert all(value == 1 for value in user_rows().values()), user_rows()

    firestore_should_fail = False
    status, body = post_delete()
    assert status == 200 and body.get('ok') is True
    assert all(value == 0 for value in user_rows().values()), user_rows()
    assert firestore_calls == [uid, uid], firestore_calls
    print('account delete: Firestore failure rolls back; success removes all user rows')
finally:
    httpd.shutdown()
    os.unlink(tmp_db.name)