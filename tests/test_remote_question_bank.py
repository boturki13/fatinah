#!/usr/bin/env python3
"""بنك الجولة البعيد: بصمة، اكتمال، منع التكرار، وحواجز الوصول."""
import hashlib
import json
import os
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault('FATINAH_ENVIRONMENT', 'staging')

import sys
sys.path.insert(0, str(ROOT))
import server as srv


def question(category, level, suffix):
    return {
        'id': f'gq-{level:02d}{suffix:018d}',
        'd': level,
        'q': f'ما السؤال المراجع للفئة {category} في المستوى {level} للنسخة {suffix}؟',
        'answer': f'الإجابة {level}-{suffix}',
        'explanation': 'شرح مراجع ومختصر.',
        'source': {'title': 'مصدر', 'url': 'https://example.com/source', 'publisher': 'ناشر'},
        'review': {'status': 'approved'},
    }


def write_bank(path, *, ready=True, tamper_digest=False,
               target_bank_size=None, declared_question_count=None):
    science = [question('علوم وتقنية', level, suffix)
               for level in range(1, 7) for suffix in (1, 2)]
    islamic = [question('القرآن الكريم', level, 100 + suffix)
               for level in range(1, 7) for suffix in (1, 2)]
    categories = {'علوم وتقنية': science, 'القرآن الكريم': islamic}
    canonical = json.dumps(categories, ensure_ascii=False,
                           separators=(',', ':')).encode('utf-8')
    digest = hashlib.sha256(canonical).hexdigest()
    document = {
        'schemaVersion': 1,
        'bankVersion': 'test-bank',
        'sha256': ('0' * 64 if tamper_digest else digest),
        'questionCount': (len(science) + len(islamic)
                          if declared_question_count is None else declared_question_count),
        'targetBankSize': (len(science) + len(islamic)
                           if target_bank_size is None else target_bank_size),
        'ready': ready,
        'categories': categories,
    }
    path.write_text(json.dumps(document, ensure_ascii=False), encoding='utf-8')


with tempfile.TemporaryDirectory() as directory:
    bank_path = Path(directory) / 'bank.json'
    srv.QUESTION_BANK_FILE = str(bank_path)
    srv._question_bank_cache.update(mtime_ns=None, document=None)

    write_bank(bank_path, ready=False, target_bank_size=25)
    status, payload = srv.select_remote_round_questions({
        'categories': ['علوم وتقنية'], 'excludeQuestionIds': [],
    })
    assert status == 503 and payload['code'] == 'question_bank_not_ready'

    write_bank(bank_path, ready=True)
    srv._question_bank_cache.update(mtime_ns=None, document=None)
    status, payload = srv.select_remote_round_questions({
        'categories': ['علوم وتقنية', 'إسلاميات'], 'excludeQuestionIds': [],
    })
    assert status == 200
    assert set(payload['questions']) == {'علوم وتقنية', 'إسلاميات'}
    assert all(len(rows) == 6 for rows in payload['questions'].values())
    assert all({row['d'] for row in rows} == set(range(1, 7))
               for rows in payload['questions'].values())

    excluded = [row['id'] for rows in payload['questions'].values() for row in rows]
    status, second = srv.select_remote_round_questions({
        'categories': ['علوم وتقنية', 'إسلاميات'],
        'excludeQuestionIds': excluded,
    })
    assert status == 200
    assert not set(excluded).intersection(
        row['id'] for rows in second['questions'].values() for row in rows)

    all_ids = [row['id'] for rows in srv.load_server_question_bank()['categories'].values()
               for row in rows]
    status, exhausted = srv.select_remote_round_questions({
        'categories': ['علوم وتقنية'], 'excludeQuestionIds': all_ids,
    })
    assert status == 409 and exhausted['code'] == 'question_pool_incomplete'

    write_bank(bank_path, ready=True, tamper_digest=True)
    srv._question_bank_cache.update(mtime_ns=None, document=None)
    try:
        srv.load_server_question_bank()
        raise AssertionError('قُبل بنك ببصمة خاطئة')
    except ValueError:
        pass

    write_bank(bank_path, ready=True, declared_question_count=23)
    srv._question_bank_cache.update(mtime_ns=None, document=None)
    try:
        srv.load_server_question_bank()
        raise AssertionError('قُبل بنك بعدد معلن لا يطابق المحتوى')
    except ValueError:
        pass

    write_bank(bank_path, ready=False)
    srv._question_bank_cache.update(mtime_ns=None, document=None)
    try:
        srv.load_server_question_bank()
        raise AssertionError('قُبل بنك مكتمل يدّعي أنه غير جاهز')
    except ValueError:
        pass

server_source = (ROOT / 'server.py').read_text(encoding='utf-8')
round_handler = server_source.split("if path == '/api/questions/round':", 1)[1].split(
    "if path == '/api/generate':", 1)[0]
assert round_handler.index('uid_matches_token') < round_handler.index('subscription_is_active')
assert round_handler.index('subscription_is_active') < round_handler.index('select_remote_round_questions')
assert "'/api/questions/round'" in server_source.split('APP_CHECK_PROTECTED_PATHS', 1)[1]

srv.QUESTION_BANK_FILE = str(ROOT / 'server-assets/question-bank/v1/bank.json')
srv._question_bank_cache.update(mtime_ns=None, document=None)
release_bank = srv.load_server_question_bank()
assert release_bank['questionCount'] == 4125
assert release_bank['targetBankSize'] == 4125
assert release_bank['ready'] is True
assert sum(len(rows) for rows in release_bank['categories'].values()) == 4125
assert "'unsupported_v2_route'" in (ROOT / 'www/app.js').read_text(encoding='utf-8')

print('✓ بنك الجولة البعيد موقّع، كامل قبل البدء، يمنع التكرار، ومحمي بالهوية والاشتراك')
