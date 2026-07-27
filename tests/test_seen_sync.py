"""
اختبارات مزامنة الأسئلة المشاهدة
==================================
تتحقق من سيناريوهين رئيسيين:
1. جهازان يرسلان قوائم مشاهَدة مختلفة → يجب أن يكون الناتج اتحاد الجهازين
2. الأسئلة المحلية غير الموجودة في السحابة يجب ألا تُحذف (pullSeenFromCloud لا تمسح)
"""

import json
import os
import sqlite3
import sys
import tempfile
import unittest

# أضف مجلد المشروع لمسار الاستيراد
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from server import normalize_topic


def build_db(path: str):
    """أنشئ قاعدة بيانات مؤقتة بنفس مخطط seen_questions."""
    conn = sqlite3.connect(path)
    conn.execute('''
        CREATE TABLE IF NOT EXISTS seen_questions (
            uid        TEXT NOT NULL,
            topic_norm TEXT NOT NULL,
            q_ids      TEXT NOT NULL DEFAULT '[]',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (uid, topic_norm)
        )
    ''')
    conn.commit()
    return conn


def server_sync(conn, uid: str, topics_in: dict) -> dict:
    """
    نسخة مباشرة من منطق /api/seen/sync في server.py.
    تُعيد dict المواضيع بعد الدمج.
    """
    result_topics = {}
    for raw_topic, ids_in in list(topics_in.items())[:100]:
        tnorm = normalize_topic(str(raw_topic))
        if not tnorm:
            continue
        ids_in = [int(x) for x in (ids_in or []) if str(x).isdigit()][:5000]
        row = conn.execute(
            'SELECT q_ids FROM seen_questions WHERE uid=? AND topic_norm=?',
            (uid, tnorm)
        ).fetchone()
        stored = []
        if row:
            try:
                stored = json.loads(row[0] or '[]')
            except Exception:
                stored = []
        merged = list(dict.fromkeys(stored + ids_in))[:5000]
        conn.execute('''
            INSERT INTO seen_questions (uid, topic_norm, q_ids, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(uid, topic_norm) DO UPDATE SET
                q_ids=excluded.q_ids, updated_at=CURRENT_TIMESTAMP
        ''', (uid, tnorm, json.dumps(merged)))
        result_topics[tnorm] = merged

    # أضف المواضيع السحابية التي لم يرسلها العميل
    rows = conn.execute(
        'SELECT topic_norm, q_ids FROM seen_questions WHERE uid=?', (uid,)
    ).fetchall()
    for r in rows:
        if r[0] not in result_topics:
            try:
                result_topics[r[0]] = json.loads(r[1] or '[]')
            except Exception:
                result_topics[r[0]] = []
    conn.commit()
    return result_topics


def client_merge(local: dict, server_response: dict) -> dict:
    """
    نسخة مباشرة من منطق pullSeenFromCloud في index.html.
    تدمج الرد السحابي مع القائمة المحلية دون حذف أي شيء محلي.
    """
    merged = dict(local)  # نسخة من المحلي
    changed = False
    for tnorm, ids in server_response.items():
        if not isinstance(ids, list):
            continue
        prev = merged.get(tnorm, [])
        union = list(dict.fromkeys(prev + ids))[-5000:]
        if len(union) != len(prev):
            merged[tnorm] = union
            changed = True
    return merged, changed


# ════════════════════════════════════════════════════════
# الاختبارات
# ════════════════════════════════════════════════════════

class TestSeenSyncServerSide(unittest.TestCase):
    """اختبارات منطق /api/seen/sync على الخادم."""

    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
        self.conn = build_db(self.tmp.name)
        self.uid = 'user_test_001'

    def tearDown(self):
        self.conn.close()
        os.unlink(self.tmp.name)

    # ── اختبار 1: جهازان بقوائم مختلفة ──────────────────────────────────────
    def test_two_devices_different_seen_merge_to_union(self):
        """
        جهاز A شاهد أسئلة [1,2,3]، جهاز B شاهد [3,4,5] في نفس الموضوع.
        بعد مزامنة الجهاز A ثم الجهاز B يجب أن يصبح الناتج [1,2,3,4,5].
        """
        topic = 'تاريخ'

        # ── جهاز A يمزامن أولاً ──
        result_a = server_sync(self.conn, self.uid, {topic: [1, 2, 3]})
        tnorm = normalize_topic(topic)
        self.assertIn(tnorm, result_a)
        self.assertEqual(sorted(result_a[tnorm]), [1, 2, 3])

        # ── جهاز B يمزامن لاحقاً بقائمة مختلفة ──
        result_b = server_sync(self.conn, self.uid, {topic: [3, 4, 5]})
        self.assertIn(tnorm, result_b)
        # يجب أن يكون الاتحاد الكامل: 1,2,3,4,5
        self.assertEqual(sorted(result_b[tnorm]), [1, 2, 3, 4, 5],
                         'الدمج يجب أن يُعيد اتحاد الجهازين بدون تكرار')

    # ── اختبار 2: موضوعان مختلفان على جهازين ─────────────────────────────────
    def test_two_devices_different_topics_all_preserved(self):
        """
        جهاز A عنده موضوع 'رياضة' فقط، جهاز B عنده 'علوم' فقط.
        بعد مزامنة كليهما يجب أن يكون كل موضوع محفوظاً للمستخدم.
        """
        uid = 'user_topics_002'

        server_sync(self.conn, uid, {'رياضة': [10, 11]})
        result = server_sync(self.conn, uid, {'علوم': [20, 21]})

        tnorm_sport = normalize_topic('رياضة')
        tnorm_sci   = normalize_topic('علوم')

        self.assertIn(tnorm_sport, result,
                      'موضوع جهاز A يجب أن يُرجَع حتى لو لم يرسله جهاز B')
        self.assertIn(tnorm_sci, result)
        self.assertEqual(sorted(result[tnorm_sport]), [10, 11])
        self.assertEqual(sorted(result[tnorm_sci]),   [20, 21])

    # ── اختبار 3: لا تكرار في قائمة الدمج ────────────────────────────────────
    def test_no_duplicates_after_merge(self):
        """إذا أرسل الجهازان نفس المعرّف يجب أن يظهر مرة واحدة فقط."""
        topic = 'جغرافيا'
        tnorm = normalize_topic(topic)

        server_sync(self.conn, self.uid, {topic: [5, 6, 7]})
        result = server_sync(self.conn, self.uid, {topic: [6, 7, 8]})

        self.assertEqual(len(result[tnorm]), len(set(result[tnorm])),
                         'لا يجب أن توجد معرّفات مكررة بعد الدمج')
        self.assertIn(5, result[tnorm])
        self.assertIn(8, result[tnorm])

    # ── اختبار 4: قائمة فارغة لا تمسح البيانات السحابية ─────────────────────
    def test_empty_local_does_not_wipe_cloud(self):
        """
        إذا أرسل الجهاز قائمة فارغة للموضوع، يجب ألا تُحذف البيانات السحابية.
        """
        topic = 'فيزياء'
        tnorm = normalize_topic(topic)

        server_sync(self.conn, self.uid, {topic: [100, 200, 300]})
        # جهاز جديد لا يعرف أي سؤال → يرسل قائمة فارغة
        result = server_sync(self.conn, self.uid, {topic: []})

        self.assertEqual(sorted(result[tnorm]), [100, 200, 300],
                         'القائمة الفارغة لا يجب أن تمسح البيانات السحابية')

    # ── اختبار 5: مزامنة مستقلة لكل مستخدم ─────────────────────────────────
    def test_sync_is_isolated_per_user(self):
        """بيانات مستخدم لا تظهر في نتائج مستخدم آخر."""
        topic = 'كيمياء'
        tnorm = normalize_topic(topic)

        server_sync(self.conn, 'user_A', {topic: [1, 2]})
        result_b = server_sync(self.conn, 'user_B', {topic: [3, 4]})

        self.assertEqual(sorted(result_b[tnorm]), [3, 4],
                         'بيانات user_A يجب ألا تظهر في نتائج user_B')


class TestSeenSyncClientSide(unittest.TestCase):
    """اختبارات منطق pullSeenFromCloud على الجانب العميل (مُحاكى بـ Python)."""

    # ── اختبار 6: pullSeenFromCloud لا تحذف الأسئلة المحلية غير الموجودة سحابياً
    def test_pull_preserves_local_only_questions(self):
        """
        المحلي: {رياضة: [1,2,3]}، السحابة ترجع: {رياضة: [3,4,5]}
        النتيجة يجب أن تكون {رياضة: [1,2,3,4,5]} — لا يُحذف 1 ولا 2.
        """
        local = {'رياضة': [1, 2, 3]}
        server_topics = {'رياضة': [3, 4, 5]}

        result, changed = client_merge(local, server_topics)
        self.assertEqual(sorted(result['رياضة']), [1, 2, 3, 4, 5],
                         'pullSeenFromCloud يجب ألا تحذف الأسئلة المحلية')
        self.assertTrue(changed, 'يجب أن يُكتشف التغيير')

    # ── اختبار 7: موضوع محلي غائب عن السحابة يُحفظ ──────────────────────────
    def test_pull_keeps_local_topic_absent_from_cloud(self):
        """
        المحلي: {رياضة: [1,2], علوم: [9,10]}
        السحابة ترجع: {رياضة: [3,4]} فقط (بدون علوم)
        يجب أن يبقى موضوع 'علوم' في المحلي كما هو.
        """
        local = {'رياضة': [1, 2], 'علوم': [9, 10]}
        server_topics = {'رياضة': [3, 4]}

        result, _ = client_merge(local, server_topics)
        self.assertIn('علوم', result,
                      'الموضوع المحلي الغائب سحابياً يجب ألا يُحذف')
        self.assertEqual(sorted(result['علوم']), [9, 10])
        self.assertEqual(sorted(result['رياضة']), [1, 2, 3, 4])

    # ── اختبار 8: قائمة سحابية فارغة لا تمسح المحلي ─────────────────────────
    def test_pull_empty_cloud_topic_does_not_wipe_local(self):
        """
        السحابة ترجع {رياضة: []} → يجب ألا تُحذف الأسئلة المحلية لنفس الموضوع.
        """
        local = {'رياضة': [5, 6, 7]}
        server_topics = {'رياضة': []}

        result, changed = client_merge(local, server_topics)
        self.assertEqual(sorted(result['رياضة']), [5, 6, 7],
                         'القائمة السحابية الفارغة لا تمسح المحلي')
        self.assertFalse(changed, 'لا تغيير عند قائمة سحابية فارغة')

    # ── اختبار 9: سحابة فارغة كاملاً لا تمسح أي شيء محلي ───────────────────
    def test_pull_completely_empty_cloud_preserves_all_local(self):
        """
        إذا أعادت السحابة dict فارغاً (جهاز جديد) يجب أن يبقى المحلي كاملاً.
        """
        local = {'رياضة': [1], 'علوم': [2], 'تاريخ': [3]}
        result, changed = client_merge(local, {})

        self.assertEqual(result, local, 'السحابة الفارغة لا تمسح المحلي')
        self.assertFalse(changed)

    # ── اختبار 10: لا تكرار بعد الدمج في جانب العميل ────────────────────────
    def test_pull_no_duplicates_in_merged_result(self):
        """المعرّفات المشتركة بين المحلي والسحابة لا تُكرَّر."""
        local = {'رياضة': [1, 2, 3]}
        server_topics = {'رياضة': [2, 3, 4, 5]}

        result, _ = client_merge(local, server_topics)
        ids = result['رياضة']
        self.assertEqual(len(ids), len(set(ids)), 'لا تكرار بعد الدمج')
        self.assertIn(1, ids)
        self.assertIn(5, ids)


if __name__ == '__main__':
    unittest.main(verbosity=2)
