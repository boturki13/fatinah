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

REAL_IMAGE_BANK_PATH = (
    ROOT / 'server-assets/question-images/curated-question-bank.json')


def reset_image_bank_cache():
    srv._image_question_bank_cache.update(
        path=None, mtime_ns=None, size=None, document=None)


def image_asset_records(document):
    return [
        {
            'questionId': row['id'],
            'url': asset['url'],
            'mimeType': asset['mimeType'],
            'bytes': asset['bytes'],
            'sha256': asset['sha256'],
        }
        for rows in document['categories'].values()
        for row in rows for asset in row['image']['assets']
    ]


def write_image_bank(path, mutate=None, *, corrupt_sha=False,
                     corrupt_assets_sha=False):
    document = json.loads(REAL_IMAGE_BANK_PATH.read_text(encoding='utf-8'))
    if mutate:
        mutate(document)
    categories = document['categories']
    questions = [row for rows in categories.values() for row in rows]
    document['publishedCategories'] = list(categories)
    document['categoryCount'] = len(categories)
    document['questionCount'] = len(questions)
    document['targetBankSize'] = len(questions)
    document['assetCount'] = sum(
        len(row.get('image', {}).get('assets', [])) for row in questions)
    document['ready'] = True
    document['distribution'] = {
        category: {
            'count': len(rows),
            'levels': {
                str(level): sum(row.get('d') == level for row in rows)
                for level in range(1, 7)
            },
        }
        for category, rows in categories.items()
    }
    categories_digest = hashlib.sha256(json.dumps(
        categories, ensure_ascii=False,
        separators=(',', ':')).encode('utf-8')).hexdigest()
    assets_digest = hashlib.sha256(json.dumps(
        image_asset_records(document), ensure_ascii=False,
        separators=(',', ':')).encode('utf-8')).hexdigest()
    document['sha256'] = '0' * 64 if corrupt_sha else categories_digest
    document['assetsSha256'] = (
        '0' * 64 if corrupt_assets_sha else assets_digest)
    path.write_text(json.dumps(document, ensure_ascii=False), encoding='utf-8')


def assert_image_bank_rejected(path, mutate=None, **kwargs):
    write_image_bank(path, mutate, **kwargs)
    srv.IMAGE_QUESTION_BANK_FILE = str(path)
    reset_image_bank_cache()
    try:
        srv.load_server_image_question_bank()
        raise AssertionError('قُبل بنك صور تالف')
    except ValueError:
        pass


def question(category, level, suffix):
    answer = f'الإجابة {level}-{suffix}'
    return {
        'id': f'gq-{level:02d}{suffix:018d}',
        'd': level,
        'q': f'ما السؤال المراجع للفئة {category} في المستوى {level} للنسخة {suffix}؟',
        'answer': answer,
        'o': [answer, f'خيار ب {suffix}', f'خيار ج {suffix}', f'خيار د {suffix}'],
        'a': 0,
        'explanation': 'شرح مراجع ومختصر.',
        'source': {'title': 'مصدر', 'url': 'https://example.com/source', 'publisher': 'ناشر'},
        'review': {
            'status': 'approved',
            'reviewer': 'اختبار بوابة الحقائق',
            'reviewedAt': '2026-09-05',
        },
    }


def write_bank(path, *, ready=True, release_ready=None, review_status='approved', tamper_digest=False,
               target_bank_size=None, declared_question_count=None):
    science = [question('علوم وتقنية', level, suffix)
               for level in range(1, 7) for suffix in (1, 2, 3, 4)]
    islamic = [question('القرآن الكريم', level, 100 + suffix)
               for level in range(1, 7) for suffix in (1, 2, 3, 4)]
    categories = {'علوم وتقنية': science, 'القرآن الكريم': islamic}
    for rows in categories.values():
        for row in rows:
            row['review']['status'] = review_status
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
        'releaseReady': ready if release_ready is None else release_ready,
        'categories': categories,
    }
    path.write_text(json.dumps(document, ensure_ascii=False), encoding='utf-8')


with tempfile.TemporaryDirectory() as directory:
    bank_path = Path(directory) / 'bank.json'
    srv.DB_PATH = str(Path(directory) / 'question-history.db')
    srv.init_db()
    srv.QUESTION_BANK_FILE = str(bank_path)
    srv.IMAGE_QUESTION_BANK_FILE = str(REAL_IMAGE_BANK_PATH)
    srv._question_bank_cache.update(mtime_ns=None, document=None)
    reset_image_bank_cache()

    write_bank(bank_path, ready=False, target_bank_size=25)
    status, payload = srv.select_remote_round_questions({
        'categories': ['علوم وتقنية'], 'excludeQuestionIds': [],
    })
    assert status == 503 and payload['code'] == 'question_bank_not_ready'

    write_bank(bank_path, ready=True)
    srv._question_bank_cache.update(mtime_ns=None, document=None)
    retired_document = json.loads(bank_path.read_text(encoding='utf-8'))
    retired_document['categories']['ألغاز بوليسية'] = []
    retired_document['sha256'] = hashlib.sha256(json.dumps(
        retired_document['categories'], ensure_ascii=False,
        separators=(',', ':')).encode('utf-8')).hexdigest()
    bank_path.write_text(json.dumps(retired_document, ensure_ascii=False), encoding='utf-8')
    srv._question_bank_cache.update(mtime_ns=None, document=None)
    try:
        srv.load_server_question_bank()
        raise AssertionError('قُبلت فئة ملغاة داخل بنك الخادم')
    except ValueError:
        pass
    write_bank(bank_path, ready=True)
    srv._question_bank_cache.update(mtime_ns=None, document=None)
    catalog = srv.server_question_catalog()
    assert catalog['schemaVersion'] == 1
    assert catalog['questionSchemaVersion'] == 1
    assert catalog['releaseReady'] is True
    image_categories = set(json.loads(
        REAL_IMAGE_BANK_PATH.read_text(encoding='utf-8'))['categories'])
    assert {item['name'] for item in catalog['categories']} == {
        'علوم وتقنية', 'القرآن الكريم'} | image_categories
    assert catalog['questionCount'] == 348
    assert all(all(item['levels'][str(level)] >= 2 for level in range(1, 7))
               for item in catalog['categories'])
    assert all(item['questionCount'] == sum(item['levels'].values())
               for item in catalog['categories'])
    assert all(item['group'] and item['groupIcon'] and item['icon']
               for item in catalog['categories'])
    assert all(item['tone'] in {
        'gold', 'orange', 'coral', 'pink', 'purple', 'indigo',
        'blue', 'cyan', 'teal', 'green', 'lime', 'sand'}
               for item in catalog['categories'])
    assert all(isinstance(item['groupOrder'], int)
               and isinstance(item['displayOrder'], int)
               for item in catalog['categories'])
    assert all(item['kind'] == 'image' for item in catalog['categories']
               if item['name'] in image_categories)
    assert all(item['kind'] == 'text' for item in catalog['categories']
               if item['name'] not in image_categories)
    original_combined_loader = srv.load_combined_server_question_bank
    incomplete_document = json.loads(json.dumps(original_combined_loader()))
    incomplete_document['categories']['فئة مستقبلية ناقصة'] = [
        question('فئة مستقبلية ناقصة', 1, 999)
    ]
    incomplete_document['categoryKinds']['فئة مستقبلية ناقصة'] = 'text'
    incomplete_document['questionCount'] += 1
    srv.load_combined_server_question_bank = lambda: incomplete_document
    try:
        complete_catalog = srv.server_question_catalog()
    finally:
        srv.load_combined_server_question_bank = original_combined_loader
    assert 'فئة مستقبلية ناقصة' in {
        item['name'] for item in complete_catalog['categories']
    }
    assert complete_catalog['questionCount'] == sum(
        item['questionCount'] for item in complete_catalog['categories'])
    assert complete_catalog['questionCount'] == catalog['questionCount'] + 1
    assert complete_catalog['bankQuestionCount'] == catalog['questionCount'] + 1
    status, legacy_payload = srv.select_remote_round_questions({
        'categories': ['علوم وتقنية'], 'excludeQuestionIds': [],
    })
    assert status == 200
    assert legacy_payload['questionsPerLevel'] == 1
    assert len(legacy_payload['questions']['علوم وتقنية']) == 6
    status, payload = srv.select_remote_round_questions({
        'categories': ['علوم وتقنية', 'إسلاميات'], 'excludeQuestionIds': [],
        'questionsPerLevel': 2,
    })
    assert status == 200
    assert payload['questionsPerLevel'] == 2
    assert set(payload['questions']) == {'علوم وتقنية', 'إسلاميات'}
    assert all(len(rows) == 12 for rows in payload['questions'].values())
    assert all({row['d'] for row in rows} == set(range(1, 7))
               for rows in payload['questions'].values())
    assert all(all(sum(row['d'] == level for row in rows) == 2
                   for level in range(1, 7))
               for rows in payload['questions'].values())

    excluded = [row['id'] for rows in payload['questions'].values() for row in rows]
    status, second = srv.select_remote_round_questions({
        'categories': ['علوم وتقنية', 'إسلاميات'],
        'excludeQuestionIds': excluded,
        'questionsPerLevel': 2,
    })
    assert status == 200
    assert not set(excluded).intersection(
        row['id'] for rows in second['questions'].values() for row in rows)

    # الخادم هو مصدر الحقيقة لمنع التكرار: معرفات قديمة خارج
    # حد العميل 10,000 يجب أن تبقى مستبعدة عند توسيع البنك.
    history_uid = 'history-scale-user'
    protected_ids = [question('علوم وتقنية', level, 1)['id']
                     for level in range(1, 7)]
    conn = srv.db_connect()
    try:
        conn.executemany(
            'INSERT INTO question_seen (uid, question_id, category) VALUES (?, ?, ?)',
            [(history_uid, question_id, 'علوم وتقنية')
             for question_id in protected_ids]
            + [(history_uid, f'old-question-{index:05d}', 'فئة قديمة')
               for index in range(10001)],
        )
        conn.commit()
    finally:
        conn.close()
    complete_history = srv.load_all_question_seen_ids(history_uid)
    assert len(complete_history) == 10007
    assert set(protected_ids) <= complete_history
    status, history_safe = srv.select_remote_round_questions({
        'categories': ['علوم وتقنية'], 'excludeQuestionIds': [],
        'questionsPerLevel': 2,
    }, additional_excluded_ids=complete_history)
    assert status == 200
    assert not set(protected_ids).intersection(
        row['id'] for row in history_safe['questions']['علوم وتقنية'])

    reservation_uid = 'round-reservation-user'
    srv.reserve_question_round(reservation_uid, history_safe['questions'])
    reserved_ids = srv.load_all_question_seen_ids(reservation_uid)
    returned_ids = {
        row['id'] for rows in history_safe['questions'].values() for row in rows
    }
    assert reserved_ids == returned_ids
    guard = srv.acquire_question_round_guard(reservation_uid)
    srv.release_question_round_guard(guard)

    free_uid = 'free-round-bank-user'
    srv.persist_free_round_completion(free_uid)
    free_grant = srv.load_free_round_question_grant(free_uid)
    assert free_grant['entitled'] is True and free_grant['payload'] is None
    free_request = {
        'categories': ['علوم وتقنية'], 'excludeQuestionIds': [],
        'questionsPerLevel': 2,
    }
    free_hash = srv.free_round_question_request_hash(free_request)
    srv.persist_free_round_question_payload(free_uid, free_hash, history_safe)
    restored_free_grant = srv.load_free_round_question_grant(free_uid)
    assert restored_free_grant['entitled'] is True
    assert restored_free_grant['request_hash'] == free_hash
    assert restored_free_grant['payload'] == history_safe

    # A pinned grant from an older bank must not resurrect a withdrawn ID.
    # Valid current IDs from that same grant may be reused so categories with
    # exactly two questions per level can still be refreshed safely.
    srv.reserve_question_round(free_uid, history_safe['questions'])
    stale_payload = json.loads(json.dumps(history_safe))
    stale_payload['bankVersion'] = 'withdrawn-bank-version'
    withdrawn_id = 'gq-ffffffffffffffffffff'
    stale_payload['questions']['علوم وتقنية'][0]['id'] = withdrawn_id
    conn = srv.db_connect()
    try:
        conn.execute('''
            UPDATE free_rounds SET question_round_payload=? WHERE uid=?
        ''', (json.dumps(stale_payload, ensure_ascii=False), free_uid))
        conn.commit()
    finally:
        conn.close()
    stale_grant = srv.load_free_round_question_grant(free_uid)
    current_document = srv.load_combined_server_question_bank()
    assert srv.valid_stored_free_round_payload(
        stale_payload, free_request, current_document) is None
    status, refreshed_free_payload = srv.select_free_round_question_payload(
        free_uid, free_request, stale_grant)
    assert status == 200
    assert refreshed_free_payload['bankVersion'] == current_document['bankVersion']
    assert withdrawn_id not in {
        row['id'] for rows in refreshed_free_payload['questions'].values()
        for row in rows
    }
    current_science_ids = {
        row['id'] for row in current_document['categories']['علوم وتقنية']
    }
    assert all(row['id'] in current_science_ids
               for row in refreshed_free_payload['questions']['علوم وتقنية'])
    refreshed_grant = srv.load_free_round_question_grant(free_uid)
    assert refreshed_grant['payload'] == refreshed_free_payload
    status, replayed_free_payload = srv.select_free_round_question_payload(
        free_uid, free_request, refreshed_grant)
    assert status == 200 and replayed_free_payload == refreshed_free_payload

    # Autoscale: Firestore contains the entitlement, while a newly started
    # instance has an empty SQLite cache. A successful durable write must
    # populate that cache instead of failing because UPDATE rowcount was zero.
    primary_db_path = srv.DB_PATH
    autoscale_db_path = str(Path(directory) / 'autoscale-cache.db')
    srv.DB_PATH = autoscale_db_path
    srv.init_db()
    durable_calls = []
    original_firestore_available = srv.firestore_durable_available
    original_firestore_set = srv.firestore_set_document
    srv.firestore_durable_available = lambda: True
    srv.firestore_set_document = (
        lambda path, data, merge=True:
        durable_calls.append((path, data, merge)))
    try:
        autoscale_uid = 'fresh-autoscale-instance-user'
        payload_with_server_only_evidence = json.loads(json.dumps(history_safe))
        payload_with_server_only_evidence['questions']['علوم وتقنية'][0][
            'verification'] = {'raw': 'x' * (600 * 1024)}
        srv.persist_free_round_question_payload(
            autoscale_uid, free_hash, payload_with_server_only_evidence)
    finally:
        srv.firestore_durable_available = original_firestore_available
        srv.firestore_set_document = original_firestore_set
    assert durable_calls == [(
        'free_rounds/fresh-autoscale-instance-user',
        {
            'question_round_entitled': True,
            'question_round_request_hash': free_hash,
            'question_round_payload': history_safe,
        },
        True,
    )]
    conn = srv.db_connect()
    try:
        autoscale_row = conn.execute('''
            SELECT question_round_entitled, question_round_request_hash,
                   question_round_payload
            FROM free_rounds WHERE uid=?
        ''', (autoscale_uid,)).fetchone()
    finally:
        conn.close()
    assert autoscale_row is not None and autoscale_row[0] == 1
    assert autoscale_row[1] == free_hash
    assert json.loads(autoscale_row[2]) == history_safe
    srv.DB_PATH = primary_db_path

    all_ids = [row['id'] for rows in srv.load_server_question_bank()['categories'].values()
               for row in rows]
    status, exhausted = srv.select_remote_round_questions({
        'categories': ['علوم وتقنية'], 'excludeQuestionIds': all_ids,
        'questionsPerLevel': 2,
    })
    assert status == 409 and exhausted['code'] == 'question_pool_incomplete'

    status, invalid_count = srv.select_remote_round_questions({
        'categories': ['علوم وتقنية'], 'excludeQuestionIds': [],
        'questionsPerLevel': 3,
    })
    assert status == 400 and invalid_count['code'] == 'invalid_questions_per_level'

    write_bank(bank_path, ready=True, release_ready=False,
               review_status='automated_structure_pass')
    srv._question_bank_cache.update(mtime_ns=None, document=None)
    try:
        srv.server_question_catalog()
        raise AssertionError('نُشر كتالوج بنك لم يجتز التحقق الواقعي')
    except ValueError:
        pass
    status, blocked_release = srv.select_remote_round_questions({
        'categories': ['علوم وتقنية'], 'excludeQuestionIds': [],
    })
    assert status == 503 and blocked_release['code'] == 'question_bank_not_release_ready'

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

    image_tamper_path = Path(directory) / 'curated-images-tampered.json'
    assert_image_bank_rejected(image_tamper_path, corrupt_sha=True)
    assert_image_bank_rejected(image_tamper_path, corrupt_assets_sha=True)

    def corrupt_schema(document):
        document['schemaVersion'] = 2

    assert_image_bank_rejected(image_tamper_path, corrupt_schema)

    def remove_review_approval(document):
        first = next(iter(document['categories'].values()))[0]
        first['review']['status'] = 'pending_review'

    assert_image_bank_rejected(image_tamper_path, remove_review_approval)

    def remove_fourth_option(document):
        first = next(iter(document['categories'].values()))[0]
        first['o'].pop()

    assert_image_bank_rejected(image_tamper_path, remove_fourth_option)

    def use_untrusted_asset_origin(document):
        first = next(iter(document['categories'].values()))[0]
        first['image']['assets'][0]['url'] = (
            'https://example.com/assets/question-images/v1/'
            'fire-extinguisher.avif')

    assert_image_bank_rejected(image_tamper_path, use_untrusted_asset_origin)

    def use_insecure_fact_source(document):
        first = next(iter(document['categories'].values()))[0]
        first['source']['url'] = 'http://example.com/fact'
        first['image']['factSource']['url'] = 'http://example.com/fact'

    assert_image_bank_rejected(image_tamper_path, use_insecure_fact_source)

    def corrupt_asset_digest_field(document):
        first = next(iter(document['categories'].values()))[0]
        first['image']['assets'][0]['sha256'] = 'not-a-sha256'

    assert_image_bank_rejected(image_tamper_path, corrupt_asset_digest_field)

    def add_prohibited_content(document):
        first = next(iter(document['categories'].values()))[0]
        first['answer'] = 'إسرائيل'
        first['o'][first['a']] = first['answer']

    assert_image_bank_rejected(image_tamper_path, add_prohibited_content)

    def leave_one_question_for_a_level(document):
        first_category = next(iter(document['categories']))
        rows = document['categories'][first_category]
        removed = next(row for row in rows if row['d'] == 1)
        rows.remove(removed)

    assert_image_bank_rejected(image_tamper_path, leave_one_question_for_a_level)

    def mismatch_id_and_asset_version(document):
        first = next(iter(document['categories'].values()))[0]
        first['id'] = first['id'].replace('img-v1-', 'img-v3-', 1)

    assert_image_bank_rejected(
        image_tamper_path, mismatch_id_and_asset_version)

    def mismatch_id_and_asset_stem(document):
        first = next(iter(document['categories'].values()))[0]
        first['image']['assets'][0]['url'] = first['image']['assets'][0][
            'url'].replace('fire-extinguisher.avif', 'different-stem.avif')

    assert_image_bank_rejected(image_tamper_path, mismatch_id_and_asset_stem)

    # توسعة مستقبلية: نسخة أصول v3 مقبولة من دون تغيير التطبيق،
    # مع بقاء ID ومساري AVIF/WebP متطابقين.
    def promote_one_question_to_v3(document):
        first = next(iter(document['categories'].values()))[0]
        first['id'] = first['id'].replace('img-v1-', 'img-v3-', 1)
        for asset in first['image']['assets']:
            asset['url'] = asset['url'].replace(
                '/assets/question-images/v1/',
                '/assets/question-images/v3/', 1)

    write_image_bank(image_tamper_path, promote_one_question_to_v3)
    srv.IMAGE_QUESTION_BANK_FILE = str(image_tamper_path)
    reset_image_bank_cache()
    v3_bank = srv.load_server_image_question_bank()
    assert next(iter(v3_bank['categories'].values()))[0]['id'].startswith(
        'img-v3-')

server_source = (ROOT / 'server.py').read_text(encoding='utf-8')
round_handler = server_source.split("if path == '/api/questions/round':", 1)[1].split(
    "if path == '/api/generate':", 1)[0]
assert round_handler.index('uid_matches_token') < round_handler.index('subscription_is_active')
assert round_handler.index('subscription_is_active') < round_handler.index('select_remote_round_questions')
assert round_handler.index('load_all_question_seen_ids') < round_handler.index('select_remote_round_questions')
assert round_handler.index('select_remote_round_questions') < round_handler.index('reserve_question_round')
assert 'select_free_round_question_payload' in round_handler
assert "'/api/questions/round'" in server_source.split('APP_CHECK_PROTECTED_PATHS', 1)[1]
assert "'/api/questions/catalog': 'question_bank'" in server_source
assert "'/api/questions/reservations/release': 'question_history'" in server_source

srv.QUESTION_BANK_FILE = str(ROOT / 'server-assets/question-bank/v1/bank.json')
srv.IMAGE_QUESTION_BANK_FILE = str(REAL_IMAGE_BANK_PATH)
srv._question_bank_cache.update(mtime_ns=None, document=None)
reset_image_bank_cache()
release_bank = srv.load_server_question_bank()
release_image_bank = srv.load_server_image_question_bank()
assert release_bank['questionCount'] == 2892
assert release_bank['targetBankSize'] == 2892
assert release_bank['ready'] is True
assert release_bank['releaseReady'] is True
assert release_bank['factuallyVerifiedCount'] == release_bank['questionCount']
assert release_bank['releaseBlockers'] == []
assert len(release_bank['categories']) == 33
assert 'رتّبها صح' not in release_bank['categories']
assert 'رياضيات وحساب' not in release_bank['categories']
assert 'ألغاز بوليسية' not in release_bank['categories']
assert {'الكويت', 'دول الخليج', 'من أنا؟', 'منظمات دولية'} <= set(release_bank['categories'])
assert sum(len(rows) for rows in release_bank['categories'].values()) == 2892
assert all(len(rows) == (12 if name == 'القرآن الكريم' else 90)
           for name, rows in release_bank['categories'].items())
assert all({band: sum(question['band'] == band for question in rows)
            for band in ('easy', 'medium', 'hard')} ==
           ({'easy': 4, 'medium': 4, 'hard': 4} if name == 'القرآن الكريم'
            else {'easy': 30, 'medium': 30, 'hard': 30})
           for name, rows in release_bank['categories'].items())
assert all({question['d'] for question in rows} == set(range(1, 7))
           for rows in release_bank['categories'].values())
assert all(len(question['o']) == 4 and question['o'][question['a']] == question['answer']
           for rows in release_bank['categories'].values() for question in rows)
assert all(question['review']['status'] == 'approved'
           for rows in release_bank['categories'].values() for question in rows)
assert release_image_bank['questionCount'] == 300
assert release_image_bank['targetBankSize'] == 300
assert release_image_bank['assetCount'] == 600
assert release_image_bank['questionsPerLevel'] == 2
assert release_image_bank['ready'] is True
assert release_image_bank['releaseReady'] is True
assert len(release_image_bank['categories']) == 7
assert all(all(sum(question['d'] == level for question in rows) >= 2
                   for level in range(1, 7))
               for rows in release_image_bank['categories'].values())
assert all(len(question['o']) == 4 and
           question['o'][question['a']] == question['answer'] and
           question['review']['status'] == 'approved' and
           len(question['image']['assets']) == 2
           for rows in release_image_bank['categories'].values()
           for question in rows)
release_catalog = srv.server_question_catalog()
assert release_catalog['releaseReady'] is True
assert release_catalog['questionCount'] == 3192
assert len(release_catalog['categories']) == 40
catalog_by_name = {item['name']: item for item in release_catalog['categories']}
assert set(release_image_bank['categories']) <= set(catalog_by_name)
assert all(catalog_by_name[category]['kind'] == 'image'
           for category in release_image_bank['categories'])
assert all(catalog_by_name[category]['levels'] ==
           release_image_bank['distribution'][category]['levels']
           for category in release_image_bank['categories'])
assert all(item['questionCount'] == sum(item['levels'].values())
           for item in release_catalog['categories'])
assert all(item['group'] and item['groupIcon'] and item['icon']
           for item in release_catalog['categories'])
status, published_release = srv.select_remote_round_questions({
    'categories': ['الكويت'], 'excludeQuestionIds': [], 'questionsPerLevel': 2,
})
assert status == 200
assert published_release['questionsPerLevel'] == 2
assert len(published_release['questions']['الكويت']) == 12
assert all(sum(question['d'] == level
               for question in published_release['questions']['الكويت']) == 2
           for level in range(1, 7))
assert all(question['review']['status'] == 'approved'
           for question in published_release['questions']['الكويت'])
status, published_image_release = srv.select_remote_round_questions({
    'categories': ['وين هالمعلم؟'], 'excludeQuestionIds': [],
    'questionsPerLevel': 2,
})
assert status == 200
assert published_image_release['bankVersion'] == release_catalog['bankVersion']
image_round = published_image_release['questions']['وين هالمعلم؟']
assert len(image_round) == 12
assert all(sum(question['d'] == level for question in image_round) == 2
           for level in range(1, 7))
assert all(question['id'].startswith('img-v') and
           len(question['o']) == 4 and
           'a' not in question and 'answer' not in question and
           len(question['image']['assets']) == 2 and
           all(asset['url'].startswith(
               'https://ata20.com/assets/question-images/')
               for asset in question['image']['assets'])
           for question in image_round)

# Worst supported request: 8 categories × 12 questions. Runtime responses must
# never expose the large server verification packets or approach Firestore's
# 1 MiB document limit when the same response is pinned for a free round.
largest_request_categories = list(release_bank['categories'])[:8]
status, projected_largest_round = srv.select_remote_round_questions({
    'categories': largest_request_categories,
    'excludeQuestionIds': [],
    'questionsPerLevel': 2,
})
assert status == 200
projected_records = [
    question
    for rows in projected_largest_round['questions'].values()
    for question in rows
]
assert len(projected_records) == 8 * 12
allowed_runtime_fields = {
    'id', 'd', 'band', 'q', 'o',
    'source', 'review', 'image', 'originCategory',
}
assert all(set(question) <= allowed_runtime_fields
           for question in projected_records)
assert all('verification' not in question and 'claim' not in question
           for question in projected_records)
projected_bytes = len(json.dumps(
    projected_largest_round, ensure_ascii=False,
    separators=(',', ':')).encode('utf-8'))
assert projected_bytes < 512 * 1024
client_source = (ROOT / 'www/app.js').read_text(encoding='utf-8')
assert "payload?.code==='unsupported_v2_route'" in client_source
assert "setRemoteQuestionCatalogFailure('server_contract_outdated'" in client_source
assert 'لا رجوع إلى بنك أو كاش محلي' in client_source
assert "img-src 'self' data: blob:;" in srv.WEB_CONTENT_SECURITY_POLICY

print('✓ بنكا النص والصور منشوران ببصمات صحيحة، ويخدمان 12 سؤالاً للفئة بلا تكرار')
