#!/usr/bin/env python3
"""اختبارات حد Firestore الموزع المستخدم مع Replit Autoscale."""

from __future__ import annotations

import copy
import datetime
import io
import inspect
import json
import os
import sys
import threading
import urllib.error
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock


sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server as srv


class SharedFirestore:
    """محاكاة CAS صغيرة؛ تمثل مخزناً واحداً تراه عدة نسخ خادم."""

    def __init__(self):
        self._lock = threading.Lock()
        self._documents = {}
        self._version = 0

    def get(self, path):
        with self._lock:
            record = self._documents.get(path)
            return copy.deepcopy(record) if record is not None else None

    def create(self, path, data):
        with self._lock:
            if path in self._documents:
                return None
            self._version += 1
            update_time = f'version-{self._version}'
            self._documents[path] = {
                **copy.deepcopy(data), '_update_time': update_time,
            }
            return update_time

    def compare_and_set(self, path, data, update_time):
        with self._lock:
            current = self._documents.get(path)
            if not current or current.get('_update_time') != update_time:
                return False
            self._version += 1
            self._documents[path] = {
                **copy.deepcopy(data),
                '_update_time': f'version-{self._version}',
            }
            return True


class DistributedRateLimitTests(unittest.TestCase):
    def setUp(self):
        self.environment = os.environ.copy()
        os.environ['FATINAH_ENVIRONMENT'] = 'staging'
        os.environ['FATINAH_DISTRIBUTED_RATE_LIMIT_CONFIGURED'] = 'true'
        os.environ['FATINAH_DISTRIBUTED_RATE_LIMIT_TTL_CONFIGURED'] = 'true'
        self.firestore = SharedFirestore()
        self.patches = [
            mock.patch.object(
                srv, 'firestore_durable_available', return_value=True),
            mock.patch.object(
                srv, 'firestore_get_document', side_effect=self.firestore.get),
            mock.patch.object(
                srv, 'firestore_create_document_if_absent',
                side_effect=self.firestore.create),
            mock.patch.object(
                srv, 'firestore_set_document_if_update_time',
                side_effect=self.firestore.compare_and_set),
        ]
        for patcher in self.patches:
            patcher.start()

    def tearDown(self):
        for patcher in reversed(self.patches):
            patcher.stop()
        os.environ.clear()
        os.environ.update(self.environment)
        srv._rate_buckets.clear()

    def test_document_id_is_domain_separated_hash_not_raw_uid(self):
        path = srv._rate_limit_document_path('question-report:user-secret')
        self.assertRegex(path, r'^distributed_rate_limits/[0-9a-f]{64}$')
        self.assertNotIn('user-secret', path)

    def test_all_instances_share_one_atomic_sliding_window(self):
        key = 'metric:uid-1'

        def request(_index):
            return srv._distributed_rate_limited(key, 7, 600)

        with mock.patch.object(srv.time, 'time', return_value=1_000.0), \
             mock.patch.object(srv.time, 'sleep', return_value=None):
            with ThreadPoolExecutor(max_workers=12) as pool:
                results = list(pool.map(request, range(20)))

        self.assertEqual(results.count(False), 7)
        self.assertEqual(results.count(True), 13)
        record = self.firestore.get(srv._rate_limit_document_path(key))
        self.assertEqual(len(record['calls']), 7)
        self.assertIsInstance(record['expire_at'], datetime.datetime)
        self.assertIsNotNone(record['expire_at'].tzinfo)

    def test_expired_calls_are_removed_before_increment(self):
        key = 'question-round:uid-ref'
        path = srv._rate_limit_document_path(key)
        self.firestore.create(path, {
            'calls': [100_000, 999_500],
            'expire_at': datetime.datetime.now(datetime.timezone.utc),
        })
        with mock.patch.object(srv.time, 'time', return_value=1_000.0):
            self.assertFalse(srv._distributed_rate_limited(key, 2, 10))
        record = self.firestore.get(path)
        self.assertEqual(record['calls'], [999_500, 1_000_000])

    def test_corrupt_shared_document_fails_closed(self):
        key = 'free-round:uid-1'
        self.firestore.create(
            srv._rate_limit_document_path(key), {'calls': 'not-an-array'})
        self.assertTrue(srv.rate_limited(key, 10, 600))

    def test_production_without_configuration_fails_closed(self):
        os.environ['FATINAH_ENVIRONMENT'] = 'production'
        os.environ.pop('FATINAH_DISTRIBUTED_RATE_LIMIT_CONFIGURED', None)
        with mock.patch.object(srv, '_local_rate_limited') as local:
            self.assertTrue(srv.rate_limited('account-delete:uid-1', 5, 3600))
        local.assert_not_called()

    def test_production_without_ttl_confirmation_fails_closed(self):
        os.environ['FATINAH_ENVIRONMENT'] = 'production'
        os.environ.pop('FATINAH_DISTRIBUTED_RATE_LIMIT_TTL_CONFIGURED', None)
        with mock.patch.object(srv, '_local_rate_limited') as local:
            self.assertTrue(srv.rate_limited('question-report:uid-1', 6, 3600))
        local.assert_not_called()

    def test_firestore_outage_fails_closed_without_leaking_key(self):
        with mock.patch.object(
                srv, 'firestore_get_document',
                side_effect=TimeoutError('secret payload')), \
             mock.patch.object(srv, 'safe_log_reference', return_value='ref'):
            self.assertTrue(srv.rate_limited('account-profile:uid-1', 30, 600))

    def test_active_write_and_generation_routes_use_shared_limiter(self):
        handler_source = inspect.getsource(srv.Handler.do_POST)
        for policy_key in (
            "f'app-attest:{path}:{uid}'",
            "f'question-round:{safe_log_reference(uid)}'",
            "f'free-round:{uid}'",
            "f'question-report:{uid}'",
            "f'metric:{uid}'",
            "f'ios-diagnostics-anonymous:{rate_identity}'",
            "f'ios-diagnostics:{uid}'",
            "f'question-seen:{uid}'",
            "f'account-delete:{uid}'",
            "f'account-profile:{uid}'",
            "f'revenuecat-identity:{uid}'",
            "'revenuecat-webhook'",
        ):
            self.assertIn(policy_key, handler_source)
        self.assertIn(
            "f'legacy-ai:{uid}'",
            inspect.getsource(srv.legacy_generate_questions),
        )


class FirestoreConditionalWriteHTTPTests(unittest.TestCase):
    @staticmethod
    def http_error(status: str, code: int = 400):
        payload = json.dumps({'error': {'status': status}}).encode()
        return urllib.error.HTTPError(
            'https://firestore.googleapis.com/redacted',
            code,
            status,
            {},
            io.BytesIO(payload),
        )

    def test_enterprise_stale_update_time_returns_false(self):
        with mock.patch.object(
                srv, '_firestore_credentials', return_value=('project', 'token')), \
             mock.patch.object(
                srv.urllib.request, 'urlopen',
                side_effect=self.http_error('FAILED_PRECONDITION')):
            self.assertFalse(srv.firestore_set_document_if_update_time(
                'distributed_rate_limits/test', {'calls': [1]},
                '2026-08-27T00:00:00Z'))

    def test_enterprise_stale_delete_returns_false(self):
        with mock.patch.object(
                srv, '_firestore_credentials', return_value=('project', 'token')), \
             mock.patch.object(
                srv.urllib.request, 'urlopen',
                side_effect=self.http_error('FAILED_PRECONDITION')):
            self.assertFalse(srv.firestore_delete_document_if_update_time(
                'distributed_rate_limits/test',
                '2026-08-27T00:00:00Z'))

    def test_other_http_400_is_not_swallowed(self):
        with mock.patch.object(
                srv, '_firestore_credentials', return_value=('project', 'token')), \
             mock.patch.object(
                srv.urllib.request, 'urlopen',
                side_effect=self.http_error('INVALID_ARGUMENT')):
            with self.assertRaisesRegex(RuntimeError, 'INVALID_ARGUMENT'):
                srv.firestore_set_document_if_update_time(
                    'distributed_rate_limits/test', {'calls': [1]},
                    '2026-08-27T00:00:00Z')


if __name__ == '__main__':
    unittest.main(verbosity=2)
