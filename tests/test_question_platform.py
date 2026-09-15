import json
import os
import sqlite3
import tempfile
import unittest

import question_platform as platform


def approved_question(level=1, suffix='base'):
    return {
        'prompt': f'ما هو الخيار الصحيح للسؤال الموثق رقم {suffix}؟',
        'options': [f'صحيح {suffix}', f'خطأ أ {suffix}', f'خطأ ب {suffix}', f'خطأ ج {suffix}'],
        'correctIndex': 0,
        'level': level,
        'topic': 'علوم',
        'status': 'approved',
        'correctReason': 'هذا هو الجواب الصحيح بناءً على المرجعين المستقلين.',
        'distractorReasons': [
            'الخيار الصحيح ومطابق للمراجع.',
            'الخيار الأول البديل لا يطابق المرجع.',
            'الخيار الثاني البديل لا يطابق المرجع.',
            'الخيار الثالث البديل لا يطابق المرجع.',
        ],
        'sources': [
            {'title': 'المرجع الأول', 'url': f'https://source-a.example/{suffix}'},
            {'title': 'المرجع الثاني', 'url': f'https://source-b.example/{suffix}'},
        ],
        'verificationNotes': ['تحقق أول مستقل.', 'تحقق ثانٍ مستقل.'],
        'author': 'كاتب',
        'reviewer': 'مدقق',
        'languageReviewed': True,
        'ambiguityChecked': True,
        'playerTested': True,
        'safetyReviewed': True,
        'confidenceStatus': 'verified',
    }


class QuestionPlatformTests(unittest.TestCase):
    def setUp(self):
        handle, self.database = tempfile.mkstemp(suffix='.db')
        os.close(handle)
        platform.initialize(self.database)

    def tearDown(self):
        for suffix in ('', '-wal', '-shm'):
            try:
                os.unlink(self.database + suffix)
            except FileNotFoundError:
                pass

    def test_difficulty_is_fair_for_every_supported_length(self):
        for count in range(10, 31):
            sequence = platform.difficulty_sequence(count)
            self.assertEqual(len(sequence), count)
            self.assertEqual(sequence, sorted(sequence))
            counts = [sequence.count(level) for level in platform.LEVELS]
            self.assertLessEqual(max(counts) - min(counts), 1)
            for index in range(5):
                self.assertGreaterEqual(counts[index], counts[index + 1])
        self.assertEqual(platform.difficulty_sequence(10), [1, 1, 2, 2, 3, 3, 4, 4, 5, 6])

    def test_approval_requires_evidence_and_safety(self):
        incomplete = approved_question()
        incomplete['sources'] = []
        with self.assertRaises(platform.ValidationError) as caught:
            platform.save_question(self.database, incomplete, actor='test')
        self.assertIn('sources', {issue['code'] for issue in caught.exception.issues})

        blocked = approved_question()
        blocked['prompt'] = 'ما هو الموضوع الإسرائيلي المذكور في السؤال؟'
        with self.assertRaises(platform.ValidationError) as caught:
            platform.save_question(self.database, blocked, actor='test')
        self.assertIn('blocked_content', {issue['code'] for issue in caught.exception.issues})

        saved = platform.save_question(self.database, approved_question(), actor='test')
        self.assertTrue(saved['quality']['ready'])
        self.assertEqual(saved['status'], 'approved')

    def test_sources_must_belong_to_independent_organizations(self):
        question = approved_question()
        question['sources'] = [
            {'title': 'صفحة أولى', 'url': 'https://science.nasa.gov/a'},
            {'title': 'صفحة ثانية', 'url': 'https://science.nasa.gov/b'},
        ]
        with self.assertRaises(platform.ValidationError) as caught:
            platform.save_question(self.database, question, actor='test')
        self.assertIn('source_independence',
                      {issue['code'] for issue in caught.exception.issues})

    def seed_launch_bank(self):
        connection = sqlite3.connect(self.database)
        now = '2026-09-10T00:00:00Z'
        rows = []
        for level in platform.LEVELS:
            for number in range(100):
                suffix = f'{level}-{number}'
                rows.append((
                    f'Q-{suffix}', f'سؤال عربي موثق رقم {suffix}؟',
                    json.dumps([f'صحيح {suffix}', f'خطأ أ {suffix}', f'خطأ ب {suffix}', f'خطأ ج {suffix}'], ensure_ascii=False),
                    0, level, 'علوم', 'approved', 'تبرير صحيح وموثق للإجابة.',
                    json.dumps(['صحيح', 'سبب خطأ موثق أ', 'سبب خطأ موثق ب', 'سبب خطأ موثق ج'], ensure_ascii=False),
                    json.dumps([{'title':'A','url':f'https://a.example/{suffix}'},{'title':'B','url':f'https://b.example/{suffix}'}]),
                    json.dumps(['تحقق أول','تحقق ثاني'], ensure_ascii=False),
                    'كاتب', 'مدقق', 1, 1, 1, 1, 'verified', now, now,
                ))
        connection.executemany('''INSERT INTO editorial_questions (
            question_id,prompt,options_json,correct_index,level,topic,status,
            correct_reason,distractor_reasons_json,sources_json,verification_notes_json,
            author,reviewer,language_reviewed,ambiguity_checked,player_tested,
            safety_reviewed,confidence_status,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', rows)
        connection.commit()
        connection.close()

    def test_two_random_packs_are_private_fair_and_non_repeating(self):
        self.seed_launch_bank()
        self.assertTrue(platform.dashboard(self.database)['launchReady'])
        result = platform.ensure_packs(self.database, 'user-1', 3, 30, 2)
        self.assertEqual(len(result['packs']), 2)
        first, second = result['packs']
        first_ids = {q['questionId'] for q in first['questions']} | {
            q['questionId'] for q in first['replacements'].values()
        }
        second_ids = {q['questionId'] for q in second['questions']} | {
            q['questionId'] for q in second['replacements'].values()
        }
        self.assertTrue(first_ids.isdisjoint(second_ids))
        for pack in result['packs']:
            self.assertEqual(len(pack['questions']), 90)
            self.assertEqual(len(pack['replacements']), 18)
            self.assertNotIn('sources', json.dumps(pack, ensure_ascii=False))
            self.assertNotIn('topic', json.dumps(pack, ensure_ascii=False))
            for owner in range(3):
                owned = [q for q in pack['questions'] if q['ownerIndex'] == owner]
                self.assertEqual([q['level'] for q in owned], platform.difficulty_sequence(30))
                self.assertEqual([q['ownerQuestionNumber'] for q in owned], list(range(1, 31)))
            for position, question in enumerate(pack['questions']):
                self.assertEqual(question['ownerIndex'], position % 3)
                expected_answer = f"صحيح {question['questionId'][2:]}"
                self.assertEqual(question['options'][question['correctIndex']], expected_answer)

        started = platform.start_pack(self.database, 'user-1', first['packId'])
        replacement_id = next(iter(first['replacements'].values()))['questionId']
        self.assertEqual(started['packId'], first['packId'])
        complete = platform.complete_pack(
            self.database, 'user-1', first['packId'], [replacement_id],
            [{'questionId': first['questions'][0]['questionId'], 'answeredCorrectly': True}],
        )
        self.assertTrue(complete['ok'])

    def test_introductory_access_mints_only_one_pack(self):
        self.seed_launch_bank()
        first = platform.ensure_packs(
            self.database, 'free-user', 2, 12, 2, introductory=True)
        self.assertEqual(len(first['packs']), 1)

        # Repeating the preparation request is idempotent before play.
        repeated = platform.ensure_packs(
            self.database, 'free-user', 2, 12, 2, introductory=True)
        self.assertEqual(repeated['packs'][0]['packId'], first['packs'][0]['packId'])

        platform.start_pack(
            self.database, 'free-user', first['packs'][0]['packId'])
        with self.assertRaises(platform.AccessDeniedError):
            platform.ensure_packs(
                self.database, 'free-user', 2, 12, 2, introductory=True)

    def test_report_keeps_internal_evidence_off_player_contract(self):
        question = platform.save_question(self.database, approved_question(), actor='test')
        created = platform.create_report(self.database, 'user-1', {
            'name': 'أحمد', 'email': 'ahmad@example.com',
        }, {
            'questionId': question['questionId'], 'reason': 'unclear',
            'details': 'الصياغة تحتمل تفسيرين.',
            'selections': [{'playerIndex': 0, 'optionText': 'الخيار الأول'}],
        })
        report = platform.pending_report(self.database, created['reportId'])
        self.assertEqual(report['reporter_email'], 'ahmad@example.com')
        self.assertEqual(len(report['question']['sources']), 2)
        self.assertEqual(report['question']['correctAnswer'], question['options'][0])


if __name__ == '__main__':
    unittest.main()
