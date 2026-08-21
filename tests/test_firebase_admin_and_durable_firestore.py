#!/usr/bin/env python3
"""اختبارات وحدة لمسار Firebase Admin وحذف بيانات Firestore الدائم."""
import os
import sys
import unittest


sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server as srv


class FirebaseAdminAuthenticationTests(unittest.TestCase):
    def setUp(self):
        self.environment = os.environ.copy()
        self.verify = srv.verify_firebase_id_token

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.environment)
        srv.verify_firebase_id_token = self.verify

    def test_admin_verification_does_not_require_web_api_key(self):
        os.environ['FIREBASE_PROJECT_ID'] = 'test-project'
        os.environ['FIREBASE_SERVICE_ACCOUNT_JSON'] = '{"project_id":"test-project"}'
        os.environ.pop('GOOGLE_API_KEY', None)
        srv.verify_firebase_id_token = lambda token: (
            {'localId': 'uid-1'} if token == 'valid-token' else None
        )

        self.assertTrue(srv.uid_matches_token('uid-1', 'valid-token'))
        self.assertFalse(srv.uid_matches_token('uid-2', 'valid-token'))
        self.assertFalse(srv.uid_matches_token('uid-1', ''))

    def test_missing_admin_and_web_credentials_fails_closed(self):
        os.environ['FIREBASE_PROJECT_ID'] = 'test-project'
        os.environ.pop('FIREBASE_SERVICE_ACCOUNT_JSON', None)
        os.environ.pop('GOOGLE_API_KEY', None)
        called = []
        srv.verify_firebase_id_token = lambda _token: called.append(True)

        self.assertFalse(srv.uid_matches_token('uid-1', 'unverified-token'))
        self.assertEqual(called, [])


class DurableFirestoreTests(unittest.TestCase):
    def setUp(self):
        self.environment = os.environ.copy()
        self.get_document = srv.firestore_get_document
        self.list_documents = srv.firestore_list_documents
        self.query_documents = srv.firestore_query_documents
        self.delete_document = srv.firestore_delete_document

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.environment)
        srv.firestore_get_document = self.get_document
        srv.firestore_list_documents = self.list_documents
        srv.firestore_query_documents = self.query_documents
        srv.firestore_delete_document = self.delete_document

    def test_firestore_value_round_trip_preserves_supported_types(self):
        source = {
            'none': None,
            'flag': True,
            'count': 7,
            'ratio': 0.75,
            'label': 'فطنة',
            'items': [1, 'اثنان', False],
            'nested': {'ready': True},
        }
        encoded = {
            key: srv._firestore_value(value) for key, value in source.items()
        }
        decoded = {
            key: srv._firestore_decode_value(value)
            for key, value in encoded.items()
        }
        self.assertEqual(decoded, source)

    def test_named_database_and_document_segments_are_encoded(self):
        os.environ['FIRESTORE_DATABASE_ID'] = 'fatinah-native'
        url = srv._firestore_document_url(
            'test-project', 'users/user with space/game_events/event:1'
        )
        self.assertEqual(
            url,
            'https://firestore.googleapis.com/v1/projects/test-project/'
            'databases/fatinah-native/documents/users/user%20with%20space/'
            'game_events/event%3A1',
        )

    def test_required_storage_fails_closed_without_credentials(self):
        os.environ['FATINAH_DURABLE_STORAGE'] = 'required'
        os.environ.pop('FIREBASE_PROJECT_ID', None)
        os.environ.pop('FIREBASE_SERVICE_ACCOUNT_JSON', None)
        with self.assertRaisesRegex(RuntimeError, 'التخزين الدائم مطلوب'):
            srv.durable_write('subscriptions/uid-1', {'status': 'active'})

    def test_account_cloud_delete_includes_subcollections_and_identity(self):
        os.environ['FIREBASE_PROJECT_ID'] = 'test-project'
        os.environ['FIREBASE_SERVICE_ACCOUNT_JSON'] = '{"project_id":"test-project"}'
        srv.firestore_get_document = lambda path: (
            {'rc_app_user_id': 'rc-random-id'}
            if path == 'revenuecat_users/uid-1' else None
        )
        documents = {
            'users/uid-1/question_seen': [{'_document_id': 'question-1'}],
            'users/uid-1/game_events': [{'_document_id': 'event-1'}],
            'users/uid-1/ios_diagnostics': [{'_document_id': 'diagnostic-1'}],
        }
        srv.firestore_list_documents = lambda path: documents.get(path, [])
        def query_documents(collection, field, value, *, op='EQUAL'):
            if (collection, field, value, op) == (
                    'question_reports', 'uid', 'uid-1', 'EQUAL'):
                return [{'_document_id': 'report-1'}]
            if (collection, field, value, op) == (
                    'revenuecat_events', 'uid', 'uid-1', 'EQUAL'):
                return [{'_document_id': 'event-direct'}]
            if (collection, field, value, op) == (
                    'revenuecat_events', 'rc_ids', 'rc-random-id',
                    'ARRAY_CONTAINS'):
                return [
                    {'_document_id': 'event-direct'},
                    {'_document_id': 'event-transfer'},
                ]
            return []
        srv.firestore_query_documents = query_documents
        documents['revenuecat_pending/rc-random-id/events'] = [
            {'_document_id': 'pending-event'}
        ]
        deleted = []
        srv.firestore_delete_document = deleted.append

        srv.firestore_delete_subscription('uid-1')

        self.assertEqual(set(deleted), {
            'users/uid-1/question_seen/question-1',
            'users/uid-1/game_events/event-1',
            'users/uid-1/ios_diagnostics/diagnostic-1',
            'question_reports/report-1',
            'revenuecat_events/event-direct',
            'revenuecat_events/event-transfer',
            'revenuecat_pending/rc-random-id/events/pending-event',
            'users/uid-1',
            'subscriptions/uid-1',
            'free_rounds/uid-1',
            'revenuecat_users/uid-1',
            'ai_rate_limits/uid-1',
            'revenuecat_pending/rc-random-id',
            'revenuecat_identities/rc-random-id',
        })


if __name__ == '__main__':
    unittest.main(verbosity=2)
