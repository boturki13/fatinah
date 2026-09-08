#!/usr/bin/env python3
"""مراقبة مخزون الأسئلة: 50/25/10، بلا إخفاء أو تنبيه مكرر."""
import os
import sys
import tempfile

os.environ['FATINAH_ENVIRONMENT'] = 'test'
os.environ['FATINAH_DURABLE_STORAGE'] = 'off'
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import server as srv


def make_bank(per_level=51):
    rows = []
    for level in range(1, 7):
        for index in range(per_level):
            rows.append({
                'id': f'gq-{level:02x}{index:018x}',
                'd': level,
                'review': {'status': 'approved'},
            })
    return {
        'bankVersion': 'combined-inventory-test',
        'categories': {'فئة اختبار': rows},
    }


tmp_db = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
tmp_db.close()
original_db = srv.DB_PATH
original_loader = srv.load_combined_server_question_bank
original_firestore_available = srv.firestore_durable_available
original_firestore_list = srv.firestore_list_documents
original_firestore_batch_delete = srv.firestore_batch_delete_documents
original_sender = srv._send_question_inventory_alert_email
srv.DB_PATH = tmp_db.name
srv.load_combined_server_question_bank = lambda: make_bank()
srv.firestore_durable_available = lambda: False
srv.init_db()


def insert_played(remaining):
    document = make_bank()
    conn = srv.db_connect()
    try:
        for level in range(1, 7):
            rows = [row for row in document['categories']['فئة اختبار']
                    if row['d'] == level]
            played = rows[:len(rows) - remaining]
            conn.executemany('''
                INSERT INTO question_seen
                    (uid, question_id, category, reserved_by_round)
                VALUES ('inventory-user', ?, 'فئة اختبار', 0)
                ON CONFLICT(uid, question_id) DO UPDATE SET reserved_by_round=0
            ''', [(row['id'],) for row in played])
        conn.commit()
    finally:
        conn.close()


try:
    baseline = srv.question_inventory_snapshot(
        'inventory-user', {'فئة اختبار'})
    assert baseline['categories']['فئة اختبار']['remainingRounds'] == 51
    assert srv.monitor_question_inventory(
        'inventory-user', {'فئة اختبار'}) == 0

    # الحجز الاحتياطي لا يستهلك المخزون الذي رآه اللاعب.
    first_id = make_bank()['categories']['فئة اختبار'][0]['id']
    conn = srv.db_connect()
    try:
        conn.execute('''
            INSERT INTO question_seen
                (uid, question_id, category, reserved_by_round)
            VALUES ('inventory-user', ?, 'فئة اختبار', 1)
        ''', (first_id,))
        conn.commit()
    finally:
        conn.close()
    reserved = srv.question_inventory_snapshot(
        'inventory-user', {'فئة اختبار'})
    assert reserved['categories']['فئة اختبار']['remainingRounds'] == 51

    insert_played(50)
    assert srv.monitor_question_inventory(
        'inventory-user', {'فئة اختبار'}) == 1
    assert srv.monitor_question_inventory(
        'inventory-user', {'فئة اختبار'}) == 0

    insert_played(25)
    assert srv.monitor_question_inventory(
        'inventory-user', {'فئة اختبار'}) == 1
    insert_played(10)
    assert srv.monitor_question_inventory(
        'inventory-user', {'فئة اختبار'}) == 1
    insert_played(0)
    assert srv.monitor_question_inventory(
        'inventory-user', {'فئة اختبار'}) == 0

    conn = srv.db_connect()
    try:
        alerts = conn.execute('''
            SELECT threshold, remaining_rounds
            FROM question_inventory_alerts ORDER BY threshold DESC
        ''').fetchall()
    finally:
        conn.close()
    assert alerts == [(50, 50), (25, 25), (10, 10)]

    deliveries = []
    srv._send_question_inventory_alert_email = (
        lambda rows: deliveries.append(list(rows)) or 'sent')
    assert srv.deliver_pending_question_inventory_alerts() == 3
    assert len(deliveries) == 1 and len(deliveries[0]) == 3
    assert srv.deliver_pending_question_inventory_alerts() == 0

    # في Firestore لا يحذف endpoint السؤال المفتوح حتى لو أرسله العميل ضمن
    # قائمة الجولة؛ الحذف محصور بوثيقة reserved_by_round=true.
    cloud_reserved = 'gq-cccccccccccccccccccc'
    cloud_played = 'gq-dddddddddddddddddddd'
    conn = srv.db_connect()
    try:
        conn.executemany('''
            INSERT INTO question_seen
                (uid, question_id, category, reserved_by_round)
            VALUES ('cloud-user', ?, 'فئة اختبار', ?)
        ''', [(cloud_reserved, 1), (cloud_played, 0)])
        conn.commit()
    finally:
        conn.close()
    deleted_paths = []
    srv.firestore_durable_available = lambda: True
    srv.firestore_list_documents = lambda _path: [
        {'question_id': cloud_reserved, 'reserved_by_round': True},
        {'question_id': cloud_played, 'reserved_by_round': False},
    ]
    srv.firestore_batch_delete_documents = (
        lambda paths: deleted_paths.extend(paths))
    assert srv.release_question_round_reservations(
        'cloud-user', [cloud_reserved, cloud_played]) == 1
    assert deleted_paths == [
        f'users/cloud-user/question_seen/{cloud_reserved}']
    conn = srv.db_connect()
    try:
        remaining = conn.execute('''
            SELECT question_id, reserved_by_round FROM question_seen
            WHERE uid='cloud-user'
        ''').fetchall()
    finally:
        conn.close()
    assert remaining == [(cloud_played, 0)]
    print('question inventory alerts: visible inventory, exact thresholds, dedupe, digest passed')
finally:
    srv.DB_PATH = original_db
    srv.load_combined_server_question_bank = original_loader
    srv.firestore_durable_available = original_firestore_available
    srv.firestore_list_documents = original_firestore_list
    srv.firestore_batch_delete_documents = original_firestore_batch_delete
    srv._send_question_inventory_alert_email = original_sender
    os.unlink(tmp_db.name)
