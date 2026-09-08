#!/usr/bin/env python3
"""اختبارات مزامنة حالة RevenueCat الخادمية عند تأخر webhook."""

import json
import os
import threading
import unittest
from unittest import mock
import urllib.request
from http.server import HTTPServer

import server as srv


class FakeResponse:
    def __init__(self, payload, status=200):
        self.status = status
        self._body = json.dumps(payload).encode('utf-8')

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit=-1):
        return self._body


class RevenueCatStatusRefreshTests(unittest.TestCase):
    RC_ID = '11111111-1111-4111-8111-111111111111'

    def entitlement_payload(self, expires_date):
        return {
            'subscriber': {
                'entitlements': {
                    'premium': {
                        'expires_date': expires_date,
                        'grace_period_expires_date': None,
                    },
                },
            },
        }

    def test_future_entitlement_is_active(self):
        active, expiration = srv._revenuecat_entitlement_snapshot(
            self.entitlement_payload('2099-01-01T00:00:00Z'))
        self.assertTrue(active)
        self.assertEqual(expiration, '2099-01-01 00:00:00')

    def test_expired_entitlement_is_inactive(self):
        active, expiration = srv._revenuecat_entitlement_snapshot(
            self.entitlement_payload('2000-01-01T00:00:00Z'))
        self.assertFalse(active)
        self.assertEqual(expiration, '2000-01-01 00:00:00')

    def test_lifetime_entitlement_is_active(self):
        active, expiration = srv._revenuecat_entitlement_snapshot(
            self.entitlement_payload(None))
        self.assertTrue(active)
        self.assertIsNone(expiration)

    def test_refresh_uses_server_identity_and_persists_verified_result(self):
        captured = {}

        def open_request(request, timeout):
            captured['url'] = request.full_url
            captured['authorization'] = request.get_header('Authorization')
            captured['timeout'] = timeout
            return FakeResponse(self.entitlement_payload('2099-01-01T00:00:00Z'))

        with mock.patch.dict(os.environ, {
            'REVENUECAT_IOS_API_KEY': 'appl_TEST_PUBLIC_KEY',
        }, clear=False), mock.patch.object(
            srv, '_authoritative_revenuecat_identity', return_value=self.RC_ID,
        ) as identity, mock.patch.object(
            srv.urllib.request, 'urlopen', side_effect=open_request,
        ), mock.patch.object(
            srv, '_persist_verified_revenuecat_subscription',
        ) as persist:
            result = srv.refresh_revenuecat_subscription('firebase-user')

        self.assertTrue(result)
        identity.assert_called_once_with('firebase-user')
        self.assertTrue(captured['url'].endswith('/' + self.RC_ID))
        self.assertEqual(captured['authorization'], 'Bearer appl_TEST_PUBLIC_KEY')
        self.assertEqual(captured['timeout'], 6)
        persist.assert_called_once_with(
            'firebase-user', True, '2099-01-01 00:00:00')

    def test_missing_api_key_does_not_attempt_network(self):
        with mock.patch.dict(os.environ, {
            'REVENUECAT_IOS_API_KEY': '',
            'REVENUECAT_SECRET_API_KEY': '',
        }, clear=False), mock.patch.object(srv.urllib.request, 'urlopen') as urlopen:
            self.assertIsNone(srv.refresh_revenuecat_subscription('firebase-user'))
        urlopen.assert_not_called()

    def test_malformed_payload_fails_closed(self):
        with self.assertRaises(srv.RevenueCatStatusUnavailableError):
            srv._revenuecat_entitlement_snapshot({
                'subscriber': {'entitlements': {'premium': {
                    'expires_date': 'not-a-date',
                }}},
            })

    def test_round_rechecks_revenuecat_before_using_free_round(self):
        selected = {'called': False}

        def select_subscriber_round(_request, **_kwargs):
            selected['called'] = True
            return 200, {'schemaVersion': 1, 'questions': {}}

        with mock.patch.dict(os.environ, {
            'FATINAH_V2_APP_CHECK_ENFORCE': 'false',
            'FATINAH_V2_FEATURE_QUESTION_BANK_ENABLED': 'true',
        }, clear=False), mock.patch.object(
            srv, 'uid_matches_token', return_value=True,
        ), mock.patch.object(
            srv, 'rate_limited', return_value=False,
        ), mock.patch.object(
            srv, 'subscription_is_active', return_value=False,
        ), mock.patch.object(
            srv, 'try_refresh_revenuecat_subscription', return_value=True,
        ) as refresh, mock.patch.object(
            srv, 'acquire_question_round_guard', return_value=object(),
        ), mock.patch.object(
            srv, 'release_question_round_guard', return_value=None,
        ), mock.patch.object(
            srv, 'load_all_question_seen_ids', return_value=set(),
        ), mock.patch.object(
            srv, 'select_remote_round_questions', side_effect=select_subscriber_round,
        ), mock.patch.object(
            srv, 'reserve_question_round', return_value=None,
        ), mock.patch.object(
            srv, 'load_free_round_question_grant',
        ) as free_round:
            httpd = HTTPServer(('127.0.0.1', 0), srv.Handler)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            try:
                body = json.dumps({
                    'uid': 'firebase-user',
                    'idToken': 'valid-token',
                    'categories': ['اختبار'],
                }).encode('utf-8')
                request = urllib.request.Request(
                    f'http://127.0.0.1:{httpd.server_address[1]}/api/v2/questions/round',
                    data=body,
                    method='POST',
                    headers={
                        'Authorization': 'Bearer valid-token',
                        'Content-Type': 'application/json',
                        'X-Fatinah-API-Version': '2',
                    },
                )
                with urllib.request.urlopen(request, timeout=5) as response:
                    payload = json.loads(response.read())
                self.assertEqual(response.status, 200)
                self.assertEqual(payload['schemaVersion'], 1)
            finally:
                httpd.shutdown()
                thread.join(timeout=5)
                httpd.server_close()

        refresh.assert_called_once_with('firebase-user')
        self.assertTrue(selected['called'])
        free_round.assert_not_called()


if __name__ == '__main__':
    unittest.main()
