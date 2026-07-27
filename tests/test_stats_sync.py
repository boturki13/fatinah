"""
اختبارات /api/stats/sync
يتحقق من:
1. إرجاع القيمة الأعلى عند وجود بيانات مسبقة في قاعدة البيانات (سيناريو جهاز جديد)
2. دمج الإنجازات (union) لا استبدالها
"""
import json
import os
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.request
from http.server import HTTPServer
from unittest.mock import patch

# أضِف مجلد المشروع إلى مسار Python
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import server as srv


# ─── مساعد: قاعدة بيانات مؤقتة معزولة ───────────────────────────────────────

def make_temp_db():
    """ينشئ ملف SQLite مؤقتاً ويهيئ جداول player_stats."""
    tmp = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
    tmp.close()
    conn = sqlite3.connect(tmp.name)
    conn.execute('''
        CREATE TABLE IF NOT EXISTS player_stats (
            uid        TEXT PRIMARY KEY,
            games      INTEGER DEFAULT 0,
            correct    INTEGER DEFAULT 0,
            total_q    INTEGER DEFAULT 0,
            best_score INTEGER DEFAULT 0,
            wins       INTEGER DEFAULT 0,
            ach        TEXT    DEFAULT '{}',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    conn.commit()
    conn.close()
    return tmp.name


# ─── اختبارات ────────────────────────────────────────────────────────────────

class TestStatsSyncNewDevice(unittest.TestCase):
    """يحاكي تسجيل الدخول على جهاز جديد (بيانات محلية صفرية أو أقل من السحابة)."""

    def setUp(self):
        self.db_path = make_temp_db()
        # شغّل خادم HTTP مؤقتاً على منفذ عشوائي
        self.server = HTTPServer(('127.0.0.1', 0), srv.Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.handle_request, daemon=True)

        # استبدل مسار قاعدة البيانات والتحقق من الرمز
        self._orig_db = srv.DB_PATH
        srv.DB_PATH = self.db_path

    def tearDown(self):
        srv.DB_PATH = self._orig_db
        self.server.server_close()
        os.unlink(self.db_path)

    def _post_sync(self, payload, uid='user_test_123'):
        """ترسل POST /api/stats/sync مع uid مزيّف."""
        def fake_verify(token):
            return uid if token == 'test-token' else None

        with patch.object(srv, 'verify_firebase_token', side_effect=fake_verify):
            self.thread.start()
            url = f'http://127.0.0.1:{self.port}/api/stats/sync'
            data = json.dumps(payload).encode()
            req = urllib.request.Request(
                url, data=data,
                headers={
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer test-token',
                },
                method='POST'
            )
            with urllib.request.urlopen(req) as resp:
                return json.loads(resp.read())

    # ── اختبار 1: جهاز جديد ─ البيانات السحابية أعلى من الصفر ─────────────────
    def test_new_device_gets_cloud_stats(self):
        """
        سيناريو: اللاعب عنده 10 مباريات في السحابة.
        يسجّل الدخول على جهاز جديد يرسل صفرًا → يجب أن يعود 10.
        """
        # زرع البيانات الموجودة مسبقاً في قاعدة البيانات (الجهاز A)
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            'INSERT INTO player_stats (uid, games, correct, total_q, best_score, wins, ach) '
            'VALUES (?, ?, ?, ?, ?, ?, ?)',
            ('user_test_123', 10, 80, 100, 950, 7, '{"first_win": true}')
        )
        conn.commit()
        conn.close()

        # الجهاز الجديد يرسل أصفاراً (لا بيانات محلية)
        result = self._post_sync({
            'games': 0, 'correct': 0, 'totalQ': 0,
            'bestScore': 0, 'wins': 0, 'ach': {}
        })

        self.assertTrue(result.get('ok'))
        self.assertEqual(result['games'],     10,  'games يجب أن تعود 10 من السحابة')
        self.assertEqual(result['correct'],   80,  'correct يجب أن تعود 80 من السحابة')
        self.assertEqual(result['totalQ'],    100, 'totalQ يجب أن تعود 100 من السحابة')
        self.assertEqual(result['bestScore'], 950, 'bestScore يجب أن يعود 950 من السحابة')
        self.assertEqual(result['wins'],      7,   'wins يجب أن تعود 7 من السحابة')

    # ── اختبار 2: تُؤخذ الأعلى من كل جهاز ────────────────────────────────────
    def test_max_merge_favors_higher_values(self):
        """
        سيناريو: السحابة عندها bestScore=500، الجهاز الجديد عنده bestScore=700.
        يجب أن تُحفظ وتُعاد 700.
        """
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            'INSERT INTO player_stats (uid, games, correct, total_q, best_score, wins, ach) '
            'VALUES (?, ?, ?, ?, ?, ?, ?)',
            ('user_test_123', 5, 40, 50, 500, 3, '{}')
        )
        conn.commit()
        conn.close()

        result = self._post_sync({
            'games': 3, 'correct': 25, 'totalQ': 30,
            'bestScore': 700, 'wins': 2, 'ach': {}
        })

        self.assertTrue(result.get('ok'))
        self.assertEqual(result['games'],     5,   'games: يُؤخذ الأعلى 5 من السحابة')
        self.assertEqual(result['bestScore'], 700, 'bestScore: يُؤخذ الأعلى 700 من الجهاز')
        self.assertEqual(result['correct'],   40,  'correct: يُؤخذ الأعلى 40 من السحابة')


class TestStatsSyncAchievementsMerge(unittest.TestCase):
    """يتحقق من دمج الإنجازات (union) لا استبدالها."""

    def setUp(self):
        self.db_path = make_temp_db()
        self.server = HTTPServer(('127.0.0.1', 0), srv.Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.handle_request, daemon=True)

        self._orig_db = srv.DB_PATH
        srv.DB_PATH = self.db_path

    def tearDown(self):
        srv.DB_PATH = self._orig_db
        self.server.server_close()
        os.unlink(self.db_path)

    def _post_sync(self, payload, uid='user_ach_456'):
        def fake_verify(token):
            return uid if token == 'test-token' else None

        with patch.object(srv, 'verify_firebase_token', side_effect=fake_verify):
            self.thread.start()
            url = f'http://127.0.0.1:{self.port}/api/stats/sync'
            data = json.dumps(payload).encode()
            req = urllib.request.Request(
                url, data=data,
                headers={
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer test-token',
                },
                method='POST'
            )
            with urllib.request.urlopen(req) as resp:
                return json.loads(resp.read())

    def test_achievements_union_not_replace(self):
        """
        السحابة عندها إنجازَان: first_win وspeed_demon.
        الجهاز الجديد عنده: first_win وteam_player.
        النتيجة يجب أن تحتوي على الثلاثة.
        """
        cloud_ach = {'first_win': True, 'speed_demon': True}
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            'INSERT INTO player_stats (uid, games, correct, total_q, best_score, wins, ach) '
            'VALUES (?, ?, ?, ?, ?, ?, ?)',
            ('user_ach_456', 5, 30, 40, 300, 2, json.dumps(cloud_ach))
        )
        conn.commit()
        conn.close()

        device_ach = {'first_win': True, 'team_player': True}
        result = self._post_sync({
            'games': 1, 'correct': 5, 'totalQ': 10,
            'bestScore': 100, 'wins': 0, 'ach': device_ach
        })

        self.assertTrue(result.get('ok'))
        ach = result.get('ach', {})
        self.assertIn('first_win',   ach, 'first_win يجب أن يبقى في الدمج')
        self.assertIn('speed_demon', ach, 'speed_demon من السحابة يجب أن يبقى')
        self.assertIn('team_player', ach, 'team_player من الجهاز يجب أن يُضاف')

    def test_achievements_not_lost_when_device_has_none(self):
        """
        الجهاز الجديد يرسل ach فارغة → الإنجازات القديمة في السحابة تبقى.
        """
        cloud_ach = {'veteran': True, 'champion': True}
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            'INSERT INTO player_stats (uid, games, correct, total_q, best_score, wins, ach) '
            'VALUES (?, ?, ?, ?, ?, ?, ?)',
            ('user_ach_456', 20, 150, 200, 1200, 12, json.dumps(cloud_ach))
        )
        conn.commit()
        conn.close()

        result = self._post_sync({
            'games': 0, 'correct': 0, 'totalQ': 0,
            'bestScore': 0, 'wins': 0, 'ach': {}
        })

        self.assertTrue(result.get('ok'))
        ach = result.get('ach', {})
        self.assertIn('veteran',  ach, 'veteran يجب أن يبقى عند ach فارغة من الجهاز')
        self.assertIn('champion', ach, 'champion يجب أن يبقى عند ach فارغة من الجهاز')


if __name__ == '__main__':
    unittest.main(verbosity=2)
