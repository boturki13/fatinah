#!/usr/bin/env python3
"""Regression: عقد 1.2 لا يرسل أو يعيد محتوى محظوراً."""

from __future__ import annotations

import json
import os
import sys
import unittest
from unittest import mock


sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server as srv


class FakeGenerationResponse:
    def __init__(self, payload, status=200):
        self.payload = json.dumps(payload, ensure_ascii=False).encode()
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit):
        return self.payload


class LegacyGenerationContentPolicyTests(unittest.TestCase):
    def test_arabic_english_and_common_spellings_are_blocked(self):
        for value in (
                'تاريخ إسرائيل', 'اسرائيلي', 'إســرائيل', 'إسراءيل',
                'Israel', 'Israeli cities', 'Isreal', 'Israël', 'Tel Aviv',
                'ישראל', 'محتوى إباحي', 'الإباحية', 'بورنوغرافي',
                'pornography', 'NSFW', 'adult content'):
            with self.subTest(value=value):
                self.assertTrue(srv.legacy_content_is_blocked(value))

        for value in (
                'تاريخ الكويت', 'علوم وطبيعة', 'الأدب العربي',
                'World geography', 'Zion National Park geology',
                'التكاثر عند النباتات'):
            with self.subTest(value=value):
                self.assertFalse(srv.legacy_content_is_blocked(value))

    def test_blocked_topic_stops_before_auth_network_and_logging(self):
        base = {'uid': 'user', 'idToken': 'token', 'count': 4}
        for topic in ('إسرائيل', 'Isreal', 'مواد إباحية', 'pornographic films'):
            with self.subTest(topic=topic), \
                    mock.patch.object(
                        srv, 'legacy_v1_generation_enabled', return_value=True), \
                    mock.patch.object(srv, 'uid_matches_token') as auth, \
                    mock.patch.object(srv, 'rate_limited') as limiter, \
                    mock.patch.object(srv, 'subscription_is_active') as subscription, \
                    mock.patch.object(srv, '_open_legacy_generation_request') as upstream, \
                    mock.patch('builtins.print') as log:
                status, result = srv.legacy_generate_questions({
                    **base, 'topic': topic,
                })
                self.assertEqual(status, 400)
                self.assertEqual(result.get('code'), 'blocked_content')
                self.assertFalse(srv.legacy_content_is_blocked(result))
                auth.assert_not_called()
                limiter.assert_not_called()
                subscription.assert_not_called()
                upstream.assert_not_called()
                log.assert_not_called()

    def test_valid_topic_continues_and_upstream_output_is_filtered(self):
        upstream_result = {
            'questions': [
                {'q': 'ما عاصمة الكويت؟', 'answer': 'مدينة الكويت'},
                {'q': 'سؤال عن إسرائيل؟', 'answer': 'إجابة'},
                {'q': 'Safe question?', 'answer': 'Tel Aviv'},
                {'q': 'سؤال ظاهره سليم؟', 'answer': 'إجابة',
                 'source': {'title': 'pornography source',
                            'url': 'https://example.org/reference'}},
            ],
            'trustedSources': False,
        }
        captured = {}

        def open_request(request, timeout):
            captured['body'] = json.loads(request.data)
            captured['timeout'] = timeout
            return FakeGenerationResponse(upstream_result)

        with mock.patch.object(
                srv, 'legacy_v1_generation_enabled', return_value=True), \
                mock.patch.object(srv, 'uid_matches_token', return_value=True), \
                mock.patch.object(srv, 'rate_limited', return_value=False), \
                mock.patch.object(srv, 'subscription_is_active', return_value=True), \
                mock.patch.object(
                    srv, 'legacy_v1_generation_url',
                    return_value='https://generation.example/function'), \
                mock.patch.object(
                    srv, '_legacy_generation_endpoint_is_safe', return_value=True), \
                mock.patch.object(
                    srv, '_open_legacy_generation_request', side_effect=open_request):
            status, result = srv.legacy_generate_questions({
                'uid': 'user', 'idToken': 'token', 'topic': 'تاريخ الكويت',
                'count': 12, 'seen': [],
            })

        self.assertEqual(status, 200)
        self.assertEqual(result, {
            'questions': [{
                'q': 'ما عاصمة الكويت؟',
                'answer': 'مدينة الكويت',
            }],
            'trustedSources': False,
        })
        self.assertEqual(captured['body']['topic'], 'تاريخ الكويت')
        self.assertFalse(srv.legacy_content_is_blocked(result))

    def test_all_blocked_or_blocked_error_never_echoes_upstream_text(self):
        status, result = srv._sanitized_legacy_generation_response(200, {
            'questions': [{'q': 'Question?', 'answer': 'Israel'}],
        }, 4)
        self.assertEqual(status, 502)
        self.assertEqual(result.get('code'), 'generated_content_rejected')
        self.assertFalse(srv.legacy_content_is_blocked(result))

        status, result = srv._sanitized_legacy_generation_response(400, {
            'error': 'pornographic topic rejected upstream',
            'code': 'porn_error',
        }, 4)
        self.assertEqual(status, 400)
        self.assertNotIn('code', result)
        self.assertFalse(srv.legacy_content_is_blocked(result))


if __name__ == '__main__':
    unittest.main(verbosity=2)
