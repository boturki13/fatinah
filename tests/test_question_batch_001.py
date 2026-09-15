import os
import importlib.util
import tempfile
import unittest
from collections import Counter
from pathlib import Path

import question_platform as platform

IMPORTER_PATH = Path(__file__).resolve().parents[1] / "scripts/question-platform/import_batch.py"
SPEC = importlib.util.spec_from_file_location("question_batch_importer", IMPORTER_PATH)
IMPORTER = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(IMPORTER)
DEFAULT_BATCH = IMPORTER.DEFAULT_BATCH
expand_batch = IMPORTER.expand_batch
import_batch = IMPORTER.import_batch
load_batch = IMPORTER.load_batch


class FoundationBatchTests(unittest.TestCase):
    def setUp(self):
        handle, database = tempfile.mkstemp(suffix=".db")
        os.close(handle)
        self.database = Path(database)

    def tearDown(self):
        for suffix in ("", "-wal", "-shm"):
            try:
                Path(str(self.database) + suffix).unlink()
            except FileNotFoundError:
                pass

    def test_batch_has_sixty_balanced_review_questions(self):
        questions = expand_batch(load_batch(DEFAULT_BATCH))
        self.assertEqual(len(questions), 60)
        self.assertEqual(Counter(q["level"] for q in questions),
                         Counter({level: 10 for level in platform.LEVELS}))
        self.assertTrue(all(q["status"] == "review" for q in questions))
        self.assertTrue(all(len(q["options"]) == 4 for q in questions))
        self.assertTrue(all(len(q["sources"]) == 2 for q in questions))
        self.assertTrue(all(not q["reviewer"] and not q["playerTested"] for q in questions))
        independence_pending = [q for q in questions if "source_independence" in {
            issue["code"] for issue in platform.quality_issues(q)}]
        self.assertEqual(len(independence_pending), 0)

    def test_import_is_idempotent_and_never_auto_approves(self):
        first = import_batch(DEFAULT_BATCH, self.database, write=True)
        second = import_batch(DEFAULT_BATCH, self.database, write=True)
        self.assertEqual(first["created"], 60)
        self.assertEqual(second["unchanged"], 60)
        listing = platform.list_questions(str(self.database), limit=100)
        self.assertEqual(listing["total"], 60)
        self.assertTrue(all(q["status"] == "review" for q in listing["items"]))
        self.assertEqual(platform.dashboard(str(self.database))["counts"]["approved"], 0)


if __name__ == "__main__":
    unittest.main()
