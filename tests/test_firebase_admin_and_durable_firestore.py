#!/usr/bin/env python3
"""اختبارات وحدة لمسار Firebase Admin وحذف بيانات Firestore الدائم."""
import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock


sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server as srv
import firebase_admin_bridge as firebase_bridge


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

    def test_admin_verification_checks_revocation_and_user_existence(self):
        with mock.patch.object(
                firebase_bridge, '_firebase_app', return_value='test-app'), \
             mock.patch(
                'firebase_admin.auth.verify_id_token',
                return_value={'uid': 'uid-1'},
             ) as verify:
            self.assertEqual(
                firebase_bridge.verify_id_token('valid-token')['uid'],
                'uid-1',
            )
        verify.assert_called_once_with(
            'valid-token', app='test-app', check_revoked=True)

    def test_server_preserves_signed_recent_auth_and_provider_claims(self):
        os.environ['FIREBASE_PROJECT_ID'] = 'test-project'
        os.environ['FIREBASE_SERVICE_ACCOUNT_JSON'] = '{"project_id":"test-project"}'
        with mock.patch.object(
                firebase_bridge, 'verify_id_token', return_value={
                    'uid': 'uid-1',
                    'email': 'person@example.test',
                    'auth_time': 123456,
                    'firebase': {'sign_in_provider': 'apple.com'},
                }):
            identity = srv.verify_firebase_id_token('valid-token')

        self.assertEqual(identity, {
            'localId': 'uid-1',
            'email': 'person@example.test',
            'authTime': 123456,
            'signInProvider': 'apple.com',
        })

    def test_account_delete_accepts_only_recent_linked_authentication(self):
        os.environ['FIREBASE_PROJECT_ID'] = 'test-project'
        os.environ['FIREBASE_SERVICE_ACCOUNT_JSON'] = '{"project_id":"test-project"}'
        now = 2_000_000_000
        claims = {
            'fresh-token': {
                'localId': 'uid-1',
                'authTime': now - srv.ACCOUNT_DELETE_MAX_AUTH_AGE_SECONDS,
                'signInProvider': 'password',
            },
            'old-token': {
                'localId': 'uid-1',
                'authTime': now - srv.ACCOUNT_DELETE_MAX_AUTH_AGE_SECONDS - 1,
                'signInProvider': 'apple.com',
            },
            'missing-auth-time': {
                'localId': 'uid-1',
                'signInProvider': 'google.com',
            },
            'future-auth-time': {
                'localId': 'uid-1',
                'authTime': now + srv.ACCOUNT_DELETE_AUTH_CLOCK_SKEW_SECONDS + 1,
                'signInProvider': 'password',
            },
        }
        srv.verify_firebase_id_token = claims.get

        self.assertEqual(
            srv.authorize_account_delete(
                'uid-1', 'fresh-token', api_version='2',
                app_check_valid=True, now=now),
            (True, 'recent_auth'),
        )
        self.assertEqual(
            srv.authorize_account_delete(
                'uid-1', 'old-token', api_version='2',
                app_check_valid=True, now=now),
            (False, 'recent_auth_required'),
        )
        self.assertEqual(
            srv.authorize_account_delete(
                'uid-1', 'missing-auth-time', api_version='2',
                app_check_valid=True, now=now),
            (False, 'recent_auth_required'),
        )
        self.assertEqual(
            srv.authorize_account_delete(
                'uid-1', 'future-auth-time', api_version='2',
                app_check_valid=True, now=now),
            (False, 'recent_auth_required'),
        )
        self.assertEqual(
            srv.authorize_account_delete(
                'uid-1', '', api_version='2', app_check_valid=True, now=now),
            (False, 'invalid_auth_token'),
        )

    def test_old_anonymous_account_requires_v2_and_verified_app_check(self):
        os.environ['FIREBASE_PROJECT_ID'] = 'test-project'
        os.environ['FIREBASE_SERVICE_ACCOUNT_JSON'] = '{"project_id":"test-project"}'
        srv.verify_firebase_id_token = lambda _token: {
            'localId': 'anonymous-uid',
            'authTime': 1,
            'signInProvider': 'anonymous',
        }

        self.assertEqual(
            srv.authorize_account_delete(
                'anonymous-uid', 'token', api_version='2',
                app_check_valid=True, now=2_000_000_000),
            (True, 'anonymous_app_check'),
        )
        for api_version, app_check_valid in (('1', True), ('2', False)):
            with self.subTest(
                    api_version=api_version,
                    app_check_valid=app_check_valid):
                self.assertEqual(
                    srv.authorize_account_delete(
                        'anonymous-uid', 'token', api_version=api_version,
                        app_check_valid=app_check_valid, now=2_000_000_000),
                    (False, 'anonymous_app_check_required'),
                )


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

        timestamp = datetime(2026, 8, 21, 12, 30, tzinfo=timezone.utc)
        self.assertEqual(
            srv._firestore_value(timestamp),
            {'timestampValue': '2026-08-21T12:30:00.000000Z'},
        )

    def test_document_decoder_keeps_update_time_for_conditional_lock_release(self):
        decoded = srv._firestore_decode_document({
            'name': (
                'projects/test-project/databases/(default)/documents/'
                'service_locks/devicecheck_free_round_claim'
            ),
            'fields': {'expires_at': {'integerValue': '123'}},
            'updateTime': '2026-08-21T12:00:00.123456Z',
        })
        self.assertEqual(decoded['expires_at'], 123)
        self.assertEqual(decoded['_document_id'], 'devicecheck_free_round_claim')
        self.assertEqual(decoded['_update_time'], '2026-08-21T12:00:00.123456Z')

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
        legacy_alias = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        srv.firestore_list_documents = lambda path: documents.get(path, [])
        def query_documents(collection, field, value, *, op='EQUAL'):
            if (collection, field, value, op) == (
                    'revenuecat_identities', 'uid', 'uid-1', 'EQUAL'):
                return [{
                    '_document_id': legacy_alias,
                    'rc_app_user_id': legacy_alias,
                }]
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
            if (collection, field, value, op) == (
                    'revenuecat_events', 'rc_ids', legacy_alias,
                    'ARRAY_CONTAINS'):
                return [{'_document_id': 'event-legacy-alias'}]
            if (collection, field, value, op) == (
                    'app_attest_challenges', 'uid_hash',
                    srv._app_attest_uid_hash('uid-1'), 'EQUAL'):
                return [{'_document_id': 'challenge-1'}]
            return []
        srv.firestore_query_documents = query_documents
        documents['revenuecat_pending/rc-random-id/events'] = [
            {'_document_id': 'pending-event'}
        ]
        documents[f'revenuecat_pending/{legacy_alias}/events'] = [
            {'_document_id': 'pending-legacy-alias'}
        ]
        deleted = []
        srv.firestore_delete_document = deleted.append

        srv.firestore_delete_subscription('uid-1')

        self.assertEqual(set(deleted), {
            'users/uid-1/question_seen/question-1',
            'users/uid-1/game_events/event-1',
            'users/uid-1/ios_diagnostics/diagnostic-1',
            'question_reports/report-1',
            'app_attest_challenges/challenge-1',
            'revenuecat_events/event-direct',
            'revenuecat_events/event-transfer',
            'revenuecat_events/event-legacy-alias',
            'revenuecat_pending/rc-random-id/events/pending-event',
            f'revenuecat_pending/{legacy_alias}/events/pending-legacy-alias',
            'users/uid-1',
            'subscriptions/uid-1',
            'free_rounds/uid-1',
            'revenuecat_users/uid-1',
            'ai_rate_limits/uid-1',
            'revenuecat_pending/rc-random-id',
            'revenuecat_identities/rc-random-id',
            f'revenuecat_pending/{legacy_alias}',
            f'revenuecat_identities/{legacy_alias}',
        })


class RevenueCatIdentityTests(unittest.TestCase):
    GENERATED_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    CLIENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    OTHER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

    def setUp(self):
        self.environment = os.environ.copy()
        self.original_db_path = srv.DB_PATH
        self.database = tempfile.NamedTemporaryFile(suffix='.db', delete=False)
        self.database.close()
        srv.DB_PATH = self.database.name
        srv.init_db()

    def tearDown(self):
        srv.DB_PATH = self.original_db_path
        os.unlink(self.database.name)
        os.environ.clear()
        os.environ.update(self.environment)

    def firestore_stubs(self, initial=None):
        documents = dict(initial or {})
        counter = {'value': 0}

        def get_document(path):
            document = documents.get(path)
            return dict(document) if document else None

        def create_document(path, data):
            if path in documents:
                return None
            counter['value'] += 1
            update_time = f'update-{counter["value"]}'
            documents[path] = {**data, '_update_time': update_time}
            return update_time

        def delete_document(path, update_time):
            document = documents.get(path)
            if not document or document.get('_update_time') != update_time:
                return False
            del documents[path]
            return True

        return documents, get_document, create_document, delete_document

    def test_v2_ignores_unverified_client_uuid_and_returns_server_uuid(self):
        documents, get_document, create_document, delete_document = (
            self.firestore_stubs())
        with mock.patch.object(srv, 'firestore_get_document', get_document), \
             mock.patch.object(
                 srv, 'firestore_create_document_if_absent', create_document), \
             mock.patch.object(
                 srv, 'firestore_delete_document_if_update_time',
                 delete_document), \
             mock.patch.object(
                 srv.uuid, 'uuid4', return_value=self.GENERATED_ID):
            result = srv.claim_firestore_revenuecat_identity(
                'uid-1', legacy_hint=self.CLIENT_ID)

        self.assertEqual(result, self.GENERATED_ID)
        self.assertEqual(
            documents['revenuecat_users/uid-1']['rc_app_user_id'],
            self.GENERATED_ID,
        )
        self.assertEqual(
            documents[
                f'revenuecat_identities/{self.GENERATED_ID}']['uid'],
            'uid-1',
        )
        self.assertNotIn(
            f'revenuecat_identities/{self.CLIENT_ID}', documents)

    def test_v2_reverse_mapping_remains_canonical_over_old_alias_hint(self):
        initial = {
            'revenuecat_users/uid-1': {
                'uid': 'uid-1', 'rc_app_user_id': self.GENERATED_ID,
            },
            f'revenuecat_identities/{self.GENERATED_ID}': {
                'uid': 'uid-1', 'rc_app_user_id': self.GENERATED_ID,
            },
            f'revenuecat_identities/{self.CLIENT_ID}': {
                'uid': 'uid-1', 'rc_app_user_id': self.CLIENT_ID,
            },
        }
        documents, get_document, create_document, delete_document = (
            self.firestore_stubs(initial))
        with mock.patch.object(srv, 'firestore_get_document', get_document), \
             mock.patch.object(
                 srv, 'firestore_create_document_if_absent', create_document), \
             mock.patch.object(
                 srv, 'firestore_delete_document_if_update_time',
                 delete_document):
            result = srv.claim_firestore_revenuecat_identity(
                'uid-1', legacy_hint=self.CLIENT_ID)

        self.assertEqual(result, self.GENERATED_ID)

    def test_v2_concurrent_claim_uses_atomic_reverse_winner(self):
        winner_id = self.OTHER_ID
        documents = {}

        def get_document(path):
            document = documents.get(path)
            return dict(document) if document else None

        def create_document(path, data):
            if path == 'revenuecat_users/uid-1' and path not in documents:
                # Simulate another server winning createDocument after our GET.
                documents[path] = {
                    'uid': 'uid-1', 'rc_app_user_id': winner_id,
                    '_update_time': 'winner-update',
                }
                return None
            if path in documents:
                return None
            documents[path] = {**data, '_update_time': 'created-update'}
            return 'created-update'

        with mock.patch.object(srv, 'firestore_get_document', get_document), \
             mock.patch.object(
                 srv, 'firestore_create_document_if_absent', create_document), \
             mock.patch.object(
                 srv.uuid, 'uuid4', return_value=self.GENERATED_ID):
            result = srv.claim_firestore_revenuecat_identity('uid-1')

        self.assertEqual(result, winner_id)
        self.assertEqual(
            documents['revenuecat_users/uid-1']['rc_app_user_id'], winner_id)
        self.assertEqual(
            documents[f'revenuecat_identities/{winner_id}']['uid'], 'uid-1')
        self.assertNotIn(
            f'revenuecat_identities/{self.GENERATED_ID}', documents)

    def test_verified_legacy_mapping_repairs_missing_reverse_document(self):
        initial = {
            f'revenuecat_identities/{self.CLIENT_ID}': {
                'uid': 'uid-1', 'rc_app_user_id': self.CLIENT_ID,
            },
        }
        documents, get_document, create_document, delete_document = (
            self.firestore_stubs(initial))
        with mock.patch.object(srv, 'firestore_get_document', get_document), \
             mock.patch.object(
                 srv, 'firestore_create_document_if_absent', create_document), \
             mock.patch.object(
                 srv, 'firestore_delete_document_if_update_time',
                 delete_document):
            result = srv.claim_firestore_revenuecat_identity(
                'uid-1', legacy_hint=self.CLIENT_ID)

        self.assertEqual(result, self.CLIENT_ID)
        self.assertEqual(
            documents['revenuecat_users/uid-1']['rc_app_user_id'],
            self.CLIENT_ID,
        )

    def test_v1_rejects_unlinked_uuid_with_prior_webhook_evidence(self):
        documents, get_document, create_document, delete_document = (
            self.firestore_stubs())
        with mock.patch.object(srv, 'firestore_get_document', get_document), \
             mock.patch.object(
                 srv, 'firestore_create_document_if_absent', create_document), \
             mock.patch.object(
                 srv, 'firestore_delete_document_if_update_time',
                 delete_document), \
             mock.patch.object(
                 srv, '_firestore_revenuecat_id_has_evidence',
                 return_value=True):
            with self.assertRaises(srv.RevenueCatIdentityEvidenceError):
                srv.claim_v1_firestore_revenuecat_identity(
                    'uid-1', self.CLIENT_ID, allow_bootstrap=True)

        self.assertNotIn('revenuecat_users/uid-1', documents)
        self.assertNotIn(
            f'revenuecat_identities/{self.CLIENT_ID}', documents)

    def test_v1_existing_alias_does_not_replace_reverse_canonical_id(self):
        initial = {
            'revenuecat_users/uid-1': {
                'uid': 'uid-1', 'rc_app_user_id': self.GENERATED_ID,
            },
            f'revenuecat_identities/{self.GENERATED_ID}': {
                'uid': 'uid-1', 'rc_app_user_id': self.GENERATED_ID,
            },
            f'revenuecat_identities/{self.CLIENT_ID}': {
                'uid': 'uid-1', 'rc_app_user_id': self.CLIENT_ID,
            },
        }
        documents, get_document, create_document, delete_document = (
            self.firestore_stubs(initial))
        with mock.patch.object(srv, 'firestore_get_document', get_document), \
             mock.patch.object(
                 srv, 'firestore_create_document_if_absent', create_document), \
             mock.patch.object(
                 srv, 'firestore_delete_document_if_update_time',
                 delete_document):
            result = srv.claim_v1_firestore_revenuecat_identity(
                'uid-1', self.CLIENT_ID, allow_bootstrap=False)

        # v1 must echo the ID already configured in its SDK. The reverse record
        # is explicitly the stable v2 canonical ID; forward records are aliases.
        self.assertEqual(result, self.CLIENT_ID)
        self.assertEqual(
            documents['revenuecat_users/uid-1']['rc_app_user_id'],
            self.GENERATED_ID,
        )

    def test_v1_repairs_forward_from_matching_reverse_without_bootstrap(self):
        initial = {
            'revenuecat_users/uid-1': {
                'uid': 'uid-1', 'rc_app_user_id': self.CLIENT_ID,
            },
        }
        documents, get_document, create_document, delete_document = (
            self.firestore_stubs(initial))
        with mock.patch.object(srv, 'firestore_get_document', get_document), \
             mock.patch.object(
                 srv, 'firestore_create_document_if_absent', create_document), \
             mock.patch.object(
                 srv, 'firestore_delete_document_if_update_time',
                 delete_document), \
             mock.patch.object(
                 srv, '_firestore_revenuecat_id_has_evidence') as evidence:
            result = srv.claim_v1_firestore_revenuecat_identity(
                'uid-1', self.CLIENT_ID, allow_bootstrap=False)

        self.assertEqual(result, self.CLIENT_ID)
        self.assertEqual(
            documents[f'revenuecat_identities/{self.CLIENT_ID}']['uid'],
            'uid-1',
        )
        self.assertEqual(
            documents['revenuecat_users/uid-1']['rc_app_user_id'],
            self.CLIENT_ID,
        )
        evidence.assert_not_called()

    def test_v1_cannot_switch_different_reverse_when_bootstrap_is_closed(self):
        initial = {
            'revenuecat_users/uid-1': {
                'uid': 'uid-1', 'rc_app_user_id': self.GENERATED_ID,
            },
            f'revenuecat_identities/{self.GENERATED_ID}': {
                'uid': 'uid-1', 'rc_app_user_id': self.GENERATED_ID,
            },
        }
        documents, get_document, create_document, delete_document = (
            self.firestore_stubs(initial))
        with mock.patch.object(srv, 'firestore_get_document', get_document), \
             mock.patch.object(
                 srv, 'firestore_create_document_if_absent', create_document), \
             mock.patch.object(
                 srv, 'firestore_delete_document_if_update_time',
                 delete_document), \
             mock.patch.object(
                 srv, '_firestore_revenuecat_id_has_evidence') as evidence:
            with self.assertRaises(srv.RevenueCatV1BootstrapDisabledError):
                srv.claim_v1_firestore_revenuecat_identity(
                    'uid-1', self.CLIENT_ID, allow_bootstrap=False)

        self.assertNotIn(
            f'revenuecat_identities/{self.CLIENT_ID}', documents)
        self.assertEqual(
            documents['revenuecat_users/uid-1']['rc_app_user_id'],
            self.GENERATED_ID,
        )
        evidence.assert_not_called()

    def test_v1_new_alias_is_atomic_without_replacing_reverse_canonical_id(self):
        initial = {
            'revenuecat_users/uid-1': {
                'uid': 'uid-1', 'rc_app_user_id': self.GENERATED_ID,
            },
            f'revenuecat_identities/{self.GENERATED_ID}': {
                'uid': 'uid-1', 'rc_app_user_id': self.GENERATED_ID,
            },
        }
        documents, get_document, create_document, delete_document = (
            self.firestore_stubs(initial))
        with mock.patch.object(srv, 'firestore_get_document', get_document), \
             mock.patch.object(
                 srv, 'firestore_create_document_if_absent', create_document), \
             mock.patch.object(
                 srv, 'firestore_delete_document_if_update_time',
                 delete_document), \
             mock.patch.object(
                 srv, '_firestore_revenuecat_id_has_evidence',
                 return_value=False):
            result = srv.claim_v1_firestore_revenuecat_identity(
                'uid-1', self.CLIENT_ID, allow_bootstrap=True)

        self.assertEqual(result, self.CLIENT_ID)
        self.assertEqual(
            documents['revenuecat_users/uid-1']['rc_app_user_id'],
            self.GENERATED_ID,
        )
        self.assertEqual(
            documents[f'revenuecat_identities/{self.CLIENT_ID}']['uid'],
            'uid-1',
        )

    def test_v1_new_mapping_is_closed_by_default_in_production(self):
        documents, get_document, create_document, delete_document = (
            self.firestore_stubs())
        with mock.patch.object(srv, 'firestore_get_document', get_document), \
             mock.patch.object(
                 srv, 'firestore_create_document_if_absent', create_document), \
             mock.patch.object(
                 srv, 'firestore_delete_document_if_update_time',
                 delete_document), \
             mock.patch.object(
                 srv, '_firestore_revenuecat_id_has_evidence') as evidence:
            with self.assertRaises(srv.RevenueCatV1BootstrapDisabledError):
                srv.claim_v1_firestore_revenuecat_identity(
                    'uid-1', self.CLIENT_ID, allow_bootstrap=False)

        self.assertEqual(documents, {})
        evidence.assert_not_called()

    def test_v1_bootstrap_flag_defaults_safe_by_environment(self):
        os.environ.pop('FATINAH_V1_REVENUECAT_BOOTSTRAP_ENABLED', None)
        os.environ['FATINAH_ENVIRONMENT'] = 'production'
        self.assertFalse(srv.v1_revenuecat_bootstrap_enabled())
        os.environ['FATINAH_ENVIRONMENT'] = 'invalid-environment'
        self.assertFalse(srv.v1_revenuecat_bootstrap_enabled())
        os.environ['FATINAH_ENVIRONMENT'] = 'staging'
        self.assertFalse(srv.v1_revenuecat_bootstrap_enabled())
        os.environ['FATINAH_ENVIRONMENT'] = 'local'
        self.assertFalse(srv.v1_revenuecat_bootstrap_enabled())
        os.environ['FATINAH_ENVIRONMENT'] = 'production'
        os.environ['FATINAH_V1_REVENUECAT_BOOTSTRAP_ENABLED'] = 'true'
        self.assertTrue(srv.v1_revenuecat_bootstrap_enabled())

    def test_local_v2_creation_is_server_generated_and_stable(self):
        with mock.patch.object(
                srv.uuid, 'uuid4', return_value=self.GENERATED_ID):
            first = srv.claim_local_revenuecat_identity('uid-1')
        with mock.patch.object(
                srv.uuid, 'uuid4', return_value=self.OTHER_ID):
            second = srv.claim_local_revenuecat_identity('uid-1')

        self.assertEqual(first, self.GENERATED_ID)
        self.assertEqual(second, self.GENERATED_ID)

    def test_authoritative_firestore_claim_repairs_stale_sqlite_owner(self):
        conn = sqlite3.connect(self.database.name)
        conn.executemany('''
            INSERT INTO revenuecat_identities (uid, rc_app_user_id)
            VALUES (?,?)
        ''', (
            ('stale-owner', self.CLIENT_ID),
            ('uid-1', self.OTHER_ID),
        ))
        conn.commit()
        conn.close()

        srv.cache_revenuecat_identity(
            'uid-1', self.CLIENT_ID, authoritative=True)

        conn = sqlite3.connect(self.database.name)
        rows = conn.execute('''
            SELECT uid, rc_app_user_id FROM revenuecat_identities
            ORDER BY uid
        ''').fetchall()
        conn.close()
        self.assertEqual(rows, [('uid-1', self.CLIENT_ID)])

    def test_local_cache_rejects_stale_owner_without_firestore_authority(self):
        conn = sqlite3.connect(self.database.name)
        conn.execute('''
            INSERT INTO revenuecat_identities (uid, rc_app_user_id)
            VALUES (?,?)
        ''', ('stale-owner', self.CLIENT_ID))
        conn.commit()
        conn.close()

        with self.assertRaises(srv.RevenueCatIdentityConflictError):
            srv.cache_revenuecat_identity('uid-1', self.CLIENT_ID)

        conn = sqlite3.connect(self.database.name)
        rows = conn.execute('''
            SELECT uid, rc_app_user_id FROM revenuecat_identities
        ''').fetchall()
        conn.close()
        self.assertEqual(rows, [('stale-owner', self.CLIENT_ID)])

    def test_firestore_resolution_survives_sqlite_cache_failure(self):
        with mock.patch.object(
                srv, 'firestore_durable_available', return_value=True), \
             mock.patch.object(
                 srv, 'firestore_get_document', return_value={
                     'uid': 'uid-1', 'rc_app_user_id': self.CLIENT_ID,
                 }), \
             mock.patch.object(
                 srv, 'cache_revenuecat_identity',
                 side_effect=sqlite3.OperationalError('database is locked'),
             ) as cache:
            result = srv.resolve_revenuecat_uid([self.CLIENT_ID])

        self.assertEqual(result, 'uid-1')
        cache.assert_called_once_with(
            'uid-1', self.CLIENT_ID, authoritative=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
