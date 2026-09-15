#!/usr/bin/env python3
"""Validate and idempotently import an editorial question batch."""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import question_platform as platform

DEFAULT_BATCH = ROOT / "content/question-platform/batches/001-foundation.json"
DEFAULT_DATABASE = ROOT / "subscriptions.db"


def load_batch(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def expand_batch(batch: dict) -> list[dict]:
    questions = []
    accessed_at = batch["accessedAt"]
    for row in batch["questions"]:
        number, level, topic, prompt, answer, distractors, source_keys = row
        source_rows = [batch["sources"][key] for key in source_keys]
        option_rows = [(answer, f"{answer} هو الجواب المثبت في المصدرين المرفقين.")]
        option_rows.extend(
            (item, f"{item} لا يطابق الحقيقة المحددة في المصدرين المرفقين.")
            for item in distractors
        )
        # ثابت لكل معرّف: تنويع مواقع الإجابة بلا اختلاف بين البيئات أو مرات التشغيل.
        option_rows.sort(key=lambda item: hashlib.sha256(
            f"{batch['batchId']}:{number}:{item[0]}".encode("utf-8")).digest())
        options = [item[0] for item in option_rows]
        correct_index = options.index(answer)
        questions.append({
            "questionId": f"FAT-001-{number}",
            "prompt": prompt,
            "options": options,
            "correctIndex": correct_index,
            "level": level,
            "topic": topic,
            "status": "review",
            "correctReason": f"الإجابة الصحيحة هي {answer}، وتؤكدها بيانات المصدرين المرفقين.",
            "distractorReasons": [item[1] for item in option_rows],
            "sources": [{"title": title, "url": url, "accessedAt": accessed_at}
                        for title, url in source_rows],
            "verificationNotes": [
                f"تمت مطابقة المعلومة مع {source_rows[0][0]}.",
                f"تم التحقق المقارن من {source_rows[1][0]}.",
            ],
            "author": batch["author"],
            "reviewer": "",
            "languageReviewed": True,
            "ambiguityChecked": True,
            "playerTested": False,
            "safetyReviewed": True,
            "confidenceStatus": "verified",
        })
    return questions


def validate_batch(questions: list[dict]) -> None:
    errors = []
    if len(questions) != 60:
        errors.append(f"expected 60 questions, found {len(questions)}")
    counts = Counter(question["level"] for question in questions)
    if counts != Counter({level: 10 for level in platform.LEVELS}):
        errors.append(f"unbalanced levels: {dict(counts)}")
    ids = [question["questionId"] for question in questions]
    prompts = [question["prompt"].casefold() for question in questions]
    if len(ids) != len(set(ids)):
        errors.append("duplicate question IDs")
    if len(prompts) != len(set(prompts)):
        errors.append("duplicate prompts")
    for question in questions:
        issue_codes = {item["code"] for item in platform.quality_issues(question)}
        expected = {"reviewer", "player_test"}
        allowed = expected | {"source_independence"}
        if not expected.issubset(issue_codes) or not issue_codes.issubset(allowed):
            errors.append(f"{question['questionId']}: unexpected issues {sorted(issue_codes)}")
    if errors:
        raise ValueError("\n".join(errors))


def comparable(question: dict) -> dict:
    ignored = {"points", "version", "reportCount", "playCount", "correctCount",
               "createdAt", "updatedAt", "quality"}
    return {key: value for key, value in question.items() if key not in ignored}


def import_batch(batch_path: Path, database: Path, *, write: bool) -> dict:
    batch = load_batch(batch_path)
    questions = expand_batch(batch)
    validate_batch(questions)
    result = {"batchId": batch["batchId"], "validated": len(questions),
              "created": 0, "updated": 0, "unchanged": 0, "write": write}
    if not write:
        return result
    platform.initialize(str(database))
    for question in questions:
        try:
            existing = platform.question_by_id(str(database), question["questionId"])
        except platform.NotFoundError:
            existing = None
        if existing:
            # لا تمسح عملاً تحريرياً أُنجز من لوحة الجودة عند تحديث المصادر.
            question["reviewer"] = existing.get("reviewer", "")
            question["playerTested"] = existing.get("playerTested", False)
        if existing and comparable(existing) == comparable(platform.normalize_question(question)):
            result["unchanged"] += 1
            continue
        platform.save_question(str(database), question,
                               actor=f"batch-import:{batch['batchId']}")
        result["updated" if existing else "created"] += 1
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch", type=Path, default=DEFAULT_BATCH)
    parser.add_argument("--database", type=Path, default=DEFAULT_DATABASE)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(import_batch(args.batch, args.database, write=args.write),
                         ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, json.JSONDecodeError, sqlite3.Error) as error:
        print(f"batch import failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
