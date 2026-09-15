import json
import unittest
from collections import Counter
from pathlib import Path

import question_platform as platform


BATCH = (Path(__file__).resolve().parents[1] /
         "content/question-platform/batches/002-structured-foundation.json")


class StructuredFoundationBatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.questions = json.loads(BATCH.read_text(encoding="utf-8"))["questions"]

    def test_exact_count_balance_and_uniqueness(self):
        self.assertEqual(len(self.questions), 540)
        self.assertEqual(Counter(q["level"] for q in self.questions),
                         Counter({level: 90 for level in platform.LEVELS}))
        self.assertEqual(len({q["questionId"] for q in self.questions}), 540)
        self.assertEqual(len({q["prompt"] for q in self.questions}), 540)

    def test_every_question_passes_automated_pre_review_gates(self):
        allowed_pending = {"reviewer", "player_test"}
        for question in self.questions:
            self.assertEqual(len(question["options"]), 4)
            self.assertEqual(len(question["sources"]), 2)
            self.assertEqual(
                {issue["code"] for issue in platform.quality_issues(question)},
                allowed_pending,
                question["questionId"],
            )


if __name__ == "__main__":
    unittest.main()
