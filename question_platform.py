"""Question operations for Fatinah 1.4.

The editorial record and the player payload are deliberately separate. Sources,
review notes and distractor evidence never leave the administrative contract.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import re
import secrets
import sqlite3
import uuid
from collections import Counter, defaultdict
from urllib.parse import urlparse


LEVELS = tuple(range(1, 7))
POINTS_BY_LEVEL = {level: level * 100 for level in LEVELS}
QUESTION_STATUSES = {'draft', 'review', 'approved', 'paused', 'rejected', 'retired'}
REPORT_REASONS = {
    'incorrect_answer', 'unclear', 'outdated', 'duplicate', 'inappropriate', 'other',
}
BLOCKED_PUBLIC_CONTENT = re.compile(
    r'(?:اسرائيل|اسراءيل|اسراييل|اسرائيلي|صهيون|تل\s*ابيب|ישראל|'
    r'israel(?:i|ite)?|tel[\s_-]*aviv|'
    r'اباح|جنسي|علاقه\s+حميمه|عري|اغتصاب|'
    r'porn(?:o|graphic|ography)?|hentai|\berotic\b|\bsexual\b|'
    r'انتحار|ايذاء\s+النفس|تعذيب|قتل\s+جماعي|مخدرات|'
    r'suicide|self[\s_-]*harm|torture|massacre|rape)',
    re.IGNORECASE,
)


class QuestionPlatformError(RuntimeError):
    code = 'question_platform_error'
    status = 400


class ValidationError(QuestionPlatformError):
    code = 'invalid_question'
    status = 422

    def __init__(self, message, issues=None):
        super().__init__(message)
        self.issues = list(issues or [])


class BankNotReadyError(QuestionPlatformError):
    code = 'question_bank_not_ready'
    status = 409

    def __init__(self, availability):
        super().__init__('بنك الأسئلة لا يحتوي مخزوناً معتمداً كافياً لهذه الجولة')
        self.availability = availability


class NotFoundError(QuestionPlatformError):
    code = 'not_found'
    status = 404


class AccessDeniedError(QuestionPlatformError):
    code = 'introductory_round_consumed'
    status = 403


def _connect(db_path: str) -> sqlite3.Connection:
    connection = sqlite3.connect(db_path, timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA journal_mode=WAL')
    connection.execute('PRAGMA busy_timeout=15000')
    connection.execute('PRAGMA foreign_keys=ON')
    return connection


def _utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(
        timespec='seconds').replace('+00:00', 'Z')


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True)


def _load_json(value, fallback):
    try:
        decoded = json.loads(value or '')
        return decoded
    except (TypeError, ValueError, json.JSONDecodeError):
        return fallback


def initialize(db_path: str) -> None:
    connection = _connect(db_path)
    try:
        connection.executescript('''
            CREATE TABLE IF NOT EXISTS editorial_questions (
                question_id TEXT PRIMARY KEY,
                prompt TEXT NOT NULL,
                options_json TEXT NOT NULL,
                correct_index INTEGER NOT NULL,
                level INTEGER NOT NULL,
                topic TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'draft',
                correct_reason TEXT NOT NULL DEFAULT '',
                distractor_reasons_json TEXT NOT NULL DEFAULT '[]',
                sources_json TEXT NOT NULL DEFAULT '[]',
                verification_notes_json TEXT NOT NULL DEFAULT '[]',
                author TEXT NOT NULL DEFAULT '',
                reviewer TEXT NOT NULL DEFAULT '',
                language_reviewed INTEGER NOT NULL DEFAULT 0,
                ambiguity_checked INTEGER NOT NULL DEFAULT 0,
                player_tested INTEGER NOT NULL DEFAULT 0,
                safety_reviewed INTEGER NOT NULL DEFAULT 0,
                confidence_status TEXT NOT NULL DEFAULT 'pending',
                version INTEGER NOT NULL DEFAULT 1,
                report_count INTEGER NOT NULL DEFAULT 0,
                play_count INTEGER NOT NULL DEFAULT 0,
                correct_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_editorial_questions_status_level
                ON editorial_questions(status, level);
            CREATE INDEX IF NOT EXISTS idx_editorial_questions_topic
                ON editorial_questions(topic);

            CREATE TABLE IF NOT EXISTS question_audit_log (
                audit_id TEXT PRIMARY KEY,
                question_id TEXT,
                actor TEXT NOT NULL,
                action TEXT NOT NULL,
                details_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS player_question_cycles (
                uid TEXT NOT NULL,
                level INTEGER NOT NULL,
                cycle INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY(uid, level)
            );
            CREATE TABLE IF NOT EXISTS player_question_seen (
                uid TEXT NOT NULL,
                level INTEGER NOT NULL,
                cycle INTEGER NOT NULL,
                question_id TEXT NOT NULL,
                seen_at TEXT NOT NULL,
                PRIMARY KEY(uid, level, cycle, question_id)
            );

            CREATE TABLE IF NOT EXISTS game_packs (
                pack_id TEXT PRIMARY KEY,
                uid TEXT NOT NULL,
                player_count INTEGER NOT NULL,
                questions_per_player INTEGER NOT NULL,
                payload_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued',
                created_at TEXT NOT NULL,
                started_at TEXT,
                completed_at TEXT,
                expires_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_game_packs_uid_status
                ON game_packs(uid, status, created_at);
            CREATE TABLE IF NOT EXISTS game_pack_questions (
                pack_id TEXT NOT NULL,
                uid TEXT NOT NULL,
                question_id TEXT NOT NULL,
                level INTEGER NOT NULL,
                is_spare INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(pack_id, question_id),
                FOREIGN KEY(pack_id) REFERENCES game_packs(pack_id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_game_pack_questions_uid
                ON game_pack_questions(uid, question_id);

            CREATE TABLE IF NOT EXISTS player_question_reports (
                report_id TEXT PRIMARY KEY,
                uid TEXT NOT NULL,
                reporter_name TEXT NOT NULL DEFAULT '',
                reporter_email TEXT NOT NULL DEFAULT '',
                question_id TEXT NOT NULL,
                question_snapshot_json TEXT NOT NULL,
                selections_json TEXT NOT NULL DEFAULT '[]',
                reason TEXT NOT NULL,
                details TEXT NOT NULL DEFAULT '',
                email_status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL,
                resolved_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_player_question_reports_status
                ON player_question_reports(email_status, created_at);
        ''')
        columns = {
            row[1] for row in connection.execute(
                'PRAGMA table_info(editorial_questions)').fetchall()
        }
        if 'safety_reviewed' not in columns:
            connection.execute('''ALTER TABLE editorial_questions
                                  ADD COLUMN safety_reviewed INTEGER NOT NULL DEFAULT 0''')
        connection.commit()
    finally:
        connection.close()


def difficulty_sequence(questions_per_player: int) -> list[int]:
    try:
        count = int(questions_per_player)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValidationError('عدد الأسئلة لكل لاعب يجب أن يكون رقماً') from exc
    if not 10 <= count <= 30:
        raise ValidationError('عدد الأسئلة لكل لاعب يجب أن يكون بين 10 و30')
    base, remainder = divmod(count, len(LEVELS))
    sequence = []
    for level in LEVELS:
        sequence.extend([level] * (base + (1 if level <= remainder else 0)))
    return sequence


def _clean_list(value, maximum=20, item_maximum=800) -> list[str]:
    if not isinstance(value, list):
        return []
    result = []
    for item in value[:maximum]:
        text = str(item or '').strip()[:item_maximum]
        if text:
            result.append(text)
    return result


def _source_organization(url: str) -> str:
    """Return a conservative organization key, not merely a distinct URL."""
    hostname = (urlparse(url).hostname or '').lower().strip('.')
    labels = hostname.split('.')
    if len(labels) < 2:
        return hostname
    # Government namespaces under country-code domains belong to one owner
    # (for example all pages below e.gov.kw).
    if len(labels) >= 3 and labels[-2] in {'gov', 'gob', 'go', 'ac', 'edu'}:
        return '.'.join(labels[-3:])
    # Reserved test domains keep their full host so unit fixtures can model
    # genuinely separate publishers without depending on the network.
    if labels[-1] in {'example', 'test', 'invalid', 'localhost'}:
        return hostname
    return '.'.join(labels[-2:])


def normalize_question(data: dict, *, existing_id: str = '') -> dict:
    if not isinstance(data, dict):
        raise ValidationError('بيانات السؤال غير صالحة')
    options = _clean_list(data.get('options'), maximum=4, item_maximum=240)
    sources = []
    if isinstance(data.get('sources'), list):
        for raw in data['sources'][:8]:
            if not isinstance(raw, dict):
                continue
            source = {
                'title': str(raw.get('title') or '').strip()[:180],
                'url': str(raw.get('url') or '').strip()[:1200],
                'license': str(raw.get('license') or '').strip()[:80],
                'accessedAt': str(raw.get('accessedAt') or '').strip()[:40],
            }
            if any(source.values()):
                sources.append(source)
    try:
        correct_index = int(data.get('correctIndex'))
        level = int(data.get('level'))
    except (TypeError, ValueError):
        correct_index, level = -1, 0
    status = str(data.get('status') or 'draft').strip().lower()
    if status not in QUESTION_STATUSES:
        status = 'draft'
    return {
        'questionId': (existing_id or str(data.get('questionId') or '').strip()
                       or f'Q-{uuid.uuid4().hex[:12].upper()}')[:80],
        'prompt': str(data.get('prompt') or '').strip()[:600],
        'options': options,
        'correctIndex': correct_index,
        'level': level,
        'topic': str(data.get('topic') or '').strip()[:100],
        'status': status,
        'correctReason': str(data.get('correctReason') or '').strip()[:1600],
        'distractorReasons': _clean_list(
            data.get('distractorReasons'), maximum=4, item_maximum=1000),
        'sources': sources,
        'verificationNotes': _clean_list(
            data.get('verificationNotes'), maximum=12, item_maximum=1200),
        'author': str(data.get('author') or '').strip()[:100],
        'reviewer': str(data.get('reviewer') or '').strip()[:100],
        'languageReviewed': data.get('languageReviewed') is True,
        'ambiguityChecked': data.get('ambiguityChecked') is True,
        'playerTested': data.get('playerTested') is True,
        'safetyReviewed': data.get('safetyReviewed') is True,
        'confidenceStatus': str(
            data.get('confidenceStatus') or 'pending').strip().lower()[:30],
    }


def quality_issues(question: dict) -> list[dict]:
    issues = []
    def require(condition, code, message):
        if not condition:
            issues.append({'code': code, 'message': message})

    options = question.get('options') or []
    correct_index = question.get('correctIndex', -1)
    sources = question.get('sources') or []
    reasons = question.get('distractorReasons') or []
    public_content = json.dumps({
        'prompt': question.get('prompt', ''), 'options': options,
        'topic': question.get('topic', ''),
        'correctReason': question.get('correctReason', ''),
        'distractorReasons': reasons,
    }, ensure_ascii=False).translate(str.maketrans({
        'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ى': 'ي', 'ة': 'ه',
    }))
    require(len(question.get('prompt', '')) >= 12, 'prompt_short', 'نص السؤال قصير أو مفقود')
    require(len(options) == 4, 'options_count', 'يجب إدخال أربعة خيارات بالضبط')
    require(len({item.casefold() for item in options}) == 4,
            'options_duplicate', 'الخيارات يجب أن تكون مختلفة')
    require(correct_index in range(4), 'correct_index', 'حدد إجابة صحيحة واحدة')
    require(question.get('level') in LEVELS, 'level', 'المستوى يجب أن يكون من 1 إلى 6')
    require(bool(question.get('topic')), 'topic', 'التصنيف الداخلي مطلوب')
    require(len(question.get('correctReason', '')) >= 15,
            'correct_reason', 'سبب صحة الإجابة مطلوب')
    require(len(reasons) == 4, 'distractor_reasons_count',
            'أدخل سبباً لكل موضع من مواضع الخيارات الأربعة')
    if len(reasons) == 4 and correct_index in range(4):
        for index, reason in enumerate(reasons):
            if index != correct_index:
                require(len(reason) >= 10, f'distractor_reason_{index}',
                        f'سبب خطأ الخيار {index + 1} غير كافٍ')
    distinct_sources = {
        source.get('url', '').lower() for source in sources
        if source.get('url', '').startswith('https://')
    }
    require(len(distinct_sources) >= 2, 'sources', 'يلزم مصدران مستقلان على الأقل')
    source_organizations = {
        _source_organization(url) for url in distinct_sources
        if _source_organization(url)
    }
    require(len(source_organizations) >= 2, 'source_independence',
            'الرابطان تابعان للجهة نفسها؛ يلزم مصدر ثانٍ مستقل فعلياً')
    require(len(question.get('verificationNotes') or []) >= 2,
            'verification_notes', 'يلزم توثيق تحققين مستقلين')
    require(bool(question.get('author')), 'author', 'اسم الكاتب مطلوب')
    require(bool(question.get('reviewer')), 'reviewer', 'اسم المدقق المستقل مطلوب')
    require(question.get('author') != question.get('reviewer'),
            'independent_review', 'لا يجوز أن يكون الكاتب هو المدقق')
    require(question.get('languageReviewed') is True,
            'language_review', 'المراجعة اللغوية غير مكتملة')
    require(question.get('ambiguityChecked') is True,
            'ambiguity_review', 'فحص الغموض غير مكتمل')
    require(question.get('playerTested') is True,
            'player_test', 'التجربة على لاعبين حقيقيين غير مكتملة')
    require(BLOCKED_PUBLIC_CONTENT.search(public_content) is None,
            'blocked_content', 'المحتوى مرفوض بسبب فلتر السلامة')
    require(question.get('safetyReviewed') is True,
            'safety_review', 'مراجعة سلامة المحتوى غير مكتملة')
    require(question.get('confidenceStatus') == 'verified',
            'confidence', 'حالة الثقة يجب أن تكون verified')
    return issues


def quality_summary(question: dict) -> dict:
    issues = quality_issues(question)
    total_checks = 16
    score = max(0, round(100 * (total_checks - min(total_checks, len(issues))) / total_checks))
    return {'score': score, 'ready': not issues, 'issues': issues}


def _row_to_question(row: sqlite3.Row, *, include_internal=True) -> dict:
    question = {
        'questionId': row['question_id'], 'prompt': row['prompt'],
        'options': _load_json(row['options_json'], []),
        'correctIndex': row['correct_index'], 'level': row['level'],
        'points': POINTS_BY_LEVEL.get(row['level'], 0), 'topic': row['topic'],
        'status': row['status'], 'version': row['version'],
        'reportCount': row['report_count'], 'playCount': row['play_count'],
        'correctCount': row['correct_count'], 'createdAt': row['created_at'],
        'updatedAt': row['updated_at'],
    }
    if include_internal:
        question.update({
            'correctReason': row['correct_reason'],
            'distractorReasons': _load_json(row['distractor_reasons_json'], []),
            'sources': _load_json(row['sources_json'], []),
            'verificationNotes': _load_json(row['verification_notes_json'], []),
            'author': row['author'], 'reviewer': row['reviewer'],
            'languageReviewed': bool(row['language_reviewed']),
            'ambiguityChecked': bool(row['ambiguity_checked']),
            'playerTested': bool(row['player_tested']),
            'safetyReviewed': bool(row['safety_reviewed']),
            'confidenceStatus': row['confidence_status'],
        })
        question['quality'] = quality_summary(question)
    return question


def _audit(connection, question_id: str, actor: str, action: str, details=None):
    connection.execute('''
        INSERT INTO question_audit_log
        (audit_id, question_id, actor, action, details_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    ''', (str(uuid.uuid4()), question_id, actor[:100], action,
          _json(details or {}), _utc_now()))


def save_question(db_path: str, data: dict, actor: str) -> dict:
    normalized = normalize_question(data)
    if normalized['status'] == 'approved':
        issues = quality_issues(normalized)
        if issues:
            raise ValidationError('السؤال لا يجتاز بوابة الجودة', issues)
    now = _utc_now()
    connection = _connect(db_path)
    try:
        current = connection.execute(
            'SELECT version, created_at FROM editorial_questions WHERE question_id=?',
            (normalized['questionId'],)).fetchone()
        version = int(current['version']) + 1 if current else 1
        created_at = current['created_at'] if current else now
        connection.execute('''
            INSERT INTO editorial_questions (
                question_id, prompt, options_json, correct_index, level, topic,
                status, correct_reason, distractor_reasons_json, sources_json,
                verification_notes_json, author, reviewer, language_reviewed,
                ambiguity_checked, player_tested, safety_reviewed,
                confidence_status, version,
                created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(question_id) DO UPDATE SET
                prompt=excluded.prompt, options_json=excluded.options_json,
                correct_index=excluded.correct_index, level=excluded.level,
                topic=excluded.topic, status=excluded.status,
                correct_reason=excluded.correct_reason,
                distractor_reasons_json=excluded.distractor_reasons_json,
                sources_json=excluded.sources_json,
                verification_notes_json=excluded.verification_notes_json,
                author=excluded.author, reviewer=excluded.reviewer,
                language_reviewed=excluded.language_reviewed,
                ambiguity_checked=excluded.ambiguity_checked,
                player_tested=excluded.player_tested,
                safety_reviewed=excluded.safety_reviewed,
                confidence_status=excluded.confidence_status,
                version=excluded.version, updated_at=excluded.updated_at
        ''', (
            normalized['questionId'], normalized['prompt'], _json(normalized['options']),
            normalized['correctIndex'], normalized['level'], normalized['topic'],
            normalized['status'], normalized['correctReason'],
            _json(normalized['distractorReasons']), _json(normalized['sources']),
            _json(normalized['verificationNotes']), normalized['author'],
            normalized['reviewer'], int(normalized['languageReviewed']),
            int(normalized['ambiguityChecked']), int(normalized['playerTested']),
            int(normalized['safetyReviewed']), normalized['confidenceStatus'],
            version, created_at, now,
        ))
        _audit(connection, normalized['questionId'], actor,
               'created' if not current else 'updated',
               {'status': normalized['status'], 'version': version})
        connection.commit()
        row = connection.execute(
            'SELECT * FROM editorial_questions WHERE question_id=?',
            (normalized['questionId'],)).fetchone()
        return _row_to_question(row)
    finally:
        connection.close()


def set_question_status(db_path: str, question_id: str, status: str, actor: str) -> dict:
    requested = str(status or '').strip().lower()
    if requested not in QUESTION_STATUSES:
        raise ValidationError('حالة السؤال غير صالحة')
    connection = _connect(db_path)
    try:
        row = connection.execute(
            'SELECT * FROM editorial_questions WHERE question_id=?',
            (question_id,)).fetchone()
        if not row:
            raise NotFoundError('السؤال غير موجود')
        question = _row_to_question(row)
        if requested == 'approved':
            issues = quality_issues(question)
            if issues:
                raise ValidationError('السؤال لا يجتاز بوابة الجودة', issues)
        connection.execute('''
            UPDATE editorial_questions
            SET status=?, version=version+1, updated_at=? WHERE question_id=?
        ''', (requested, _utc_now(), question_id))
        _audit(connection, question_id, actor, 'status_changed', {'status': requested})
        connection.commit()
        updated = connection.execute(
            'SELECT * FROM editorial_questions WHERE question_id=?',
            (question_id,)).fetchone()
        return _row_to_question(updated)
    finally:
        connection.close()


def list_questions(db_path: str, *, status='', level=0, search='', limit=100, offset=0) -> dict:
    conditions, values = [], []
    if status in QUESTION_STATUSES:
        conditions.append('status=?'); values.append(status)
    if level in LEVELS:
        conditions.append('level=?'); values.append(level)
    if search:
        conditions.append('(prompt LIKE ? OR topic LIKE ? OR question_id LIKE ?)')
        needle = f'%{search[:120]}%'; values.extend([needle, needle, needle])
    where = (' WHERE ' + ' AND '.join(conditions)) if conditions else ''
    safe_limit = max(1, min(250, int(limit)))
    safe_offset = max(0, int(offset))
    connection = _connect(db_path)
    try:
        total = connection.execute(
            f'SELECT COUNT(*) FROM editorial_questions{where}', values).fetchone()[0]
        rows = connection.execute(
            f'''SELECT * FROM editorial_questions{where}
                ORDER BY updated_at DESC LIMIT ? OFFSET ?''',
            [*values, safe_limit, safe_offset]).fetchall()
        return {'items': [_row_to_question(row) for row in rows], 'total': total}
    finally:
        connection.close()


def dashboard(db_path: str) -> dict:
    connection = _connect(db_path)
    try:
        statuses = dict(connection.execute(
            'SELECT status, COUNT(*) FROM editorial_questions GROUP BY status').fetchall())
        levels = {str(level): 0 for level in LEVELS}
        levels.update({str(row[0]): row[1] for row in connection.execute('''
            SELECT level, COUNT(*) FROM editorial_questions
            WHERE status='approved' GROUP BY level
        ''').fetchall()})
        reports = connection.execute('''
            SELECT COUNT(*) FROM player_question_reports WHERE resolved_at IS NULL
        ''').fetchone()[0]
        ready = all(levels[str(level)] >= 100 for level in LEVELS)
        return {
            'counts': {status: int(statuses.get(status, 0)) for status in QUESTION_STATUSES},
            'approvedByLevel': levels,
            'minimumPerLevel': 100,
            'launchReady': ready,
            'openReports': reports,
        }
    finally:
        connection.close()


def audit_log(db_path: str, question_id='', limit=100) -> list[dict]:
    connection = _connect(db_path)
    try:
        if question_id:
            rows = connection.execute('''SELECT * FROM question_audit_log
                WHERE question_id=? ORDER BY created_at DESC LIMIT ?''',
                (question_id, min(250, int(limit)))).fetchall()
        else:
            rows = connection.execute('''SELECT * FROM question_audit_log
                ORDER BY created_at DESC LIMIT ?''', (min(250, int(limit)),)).fetchall()
        return [dict(row) | {'details': _load_json(row['details_json'], {})} for row in rows]
    finally:
        connection.close()


def cache_questions(db_path: str, documents) -> int:
    """Refresh the local read cache from durable editorial documents."""
    rows = [document for document in (documents or []) if isinstance(document, dict)]
    connection = _connect(db_path)
    try:
        for document in rows:
            normalized = normalize_question(document)
            created_at = str(document.get('createdAt') or _utc_now())
            updated_at = str(document.get('updatedAt') or created_at)
            connection.execute('''
                INSERT INTO editorial_questions (
                    question_id,prompt,options_json,correct_index,level,topic,status,
                    correct_reason,distractor_reasons_json,sources_json,
                    verification_notes_json,author,reviewer,language_reviewed,
                    ambiguity_checked,player_tested,safety_reviewed,confidence_status,
                    version,report_count,play_count,correct_count,created_at,updated_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(question_id) DO UPDATE SET
                    prompt=excluded.prompt,options_json=excluded.options_json,
                    correct_index=excluded.correct_index,level=excluded.level,
                    topic=excluded.topic,status=excluded.status,
                    correct_reason=excluded.correct_reason,
                    distractor_reasons_json=excluded.distractor_reasons_json,
                    sources_json=excluded.sources_json,
                    verification_notes_json=excluded.verification_notes_json,
                    author=excluded.author,reviewer=excluded.reviewer,
                    language_reviewed=excluded.language_reviewed,
                    ambiguity_checked=excluded.ambiguity_checked,
                    player_tested=excluded.player_tested,
                    safety_reviewed=excluded.safety_reviewed,
                    confidence_status=excluded.confidence_status,
                    version=excluded.version,report_count=excluded.report_count,
                    play_count=excluded.play_count,correct_count=excluded.correct_count,
                    created_at=excluded.created_at,updated_at=excluded.updated_at
            ''', (
                normalized['questionId'], normalized['prompt'], _json(normalized['options']),
                normalized['correctIndex'], normalized['level'], normalized['topic'],
                normalized['status'], normalized['correctReason'],
                _json(normalized['distractorReasons']), _json(normalized['sources']),
                _json(normalized['verificationNotes']), normalized['author'],
                normalized['reviewer'], int(normalized['languageReviewed']),
                int(normalized['ambiguityChecked']), int(normalized['playerTested']),
                int(normalized['safetyReviewed']), normalized['confidenceStatus'],
                max(1, int(document.get('version') or 1)),
                max(0, int(document.get('reportCount') or 0)),
                max(0, int(document.get('playCount') or 0)),
                max(0, int(document.get('correctCount') or 0)),
                created_at, updated_at,
            ))
        connection.commit()
        return len(rows)
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def question_by_id(db_path: str, question_id: str) -> dict:
    connection = _connect(db_path)
    try:
        row = connection.execute(
            'SELECT * FROM editorial_questions WHERE question_id=?',
            (str(question_id),)).fetchone()
        if not row:
            raise NotFoundError('السؤال غير موجود')
        return _row_to_question(row)
    finally:
        connection.close()


def cache_user_state(db_path: str, uid: str, *, packs=None, seen=None, cycles=None) -> None:
    """Replace one account's local cache with its durable distributed state."""
    connection = _connect(db_path)
    try:
        pack_ids = [row[0] for row in connection.execute(
            'SELECT pack_id FROM game_packs WHERE uid=?', (uid,)).fetchall()]
        if pack_ids:
            connection.executemany('DELETE FROM game_packs WHERE pack_id=?',
                                   [(pack_id,) for pack_id in pack_ids])
        connection.execute('DELETE FROM player_question_seen WHERE uid=?', (uid,))
        connection.execute('DELETE FROM player_question_cycles WHERE uid=?', (uid,))
        for item in cycles or []:
            if not isinstance(item, dict):
                continue
            level, cycle = int(item.get('level') or 0), int(item.get('cycle') or 1)
            if level in LEVELS and cycle >= 1:
                connection.execute('''INSERT INTO player_question_cycles(uid,level,cycle)
                                      VALUES (?,?,?)''', (uid, level, cycle))
        for item in seen or []:
            if not isinstance(item, dict):
                continue
            level = int(item.get('level') or 0)
            question_id = str(item.get('questionId') or item.get('_document_id') or '')
            if level not in LEVELS or not question_id:
                continue
            cycle = max(1, int(item.get('cycle') or 1))
            connection.execute('''INSERT OR REPLACE INTO player_question_seen
                (uid,level,cycle,question_id,seen_at) VALUES (?,?,?,?,?)''',
                (uid, level, cycle, question_id, str(item.get('seenAt') or _utc_now())))
        for item in packs or []:
            if not isinstance(item, dict) or not isinstance(item.get('payload'), dict):
                continue
            payload = item['payload']
            pack_id = str(payload.get('packId') or item.get('packId') or '')
            if not pack_id:
                continue
            status = str(item.get('status') or 'queued')
            if status not in {'queued', 'active', 'completed', 'cancelled'}:
                status = 'cancelled'
            connection.execute('''INSERT OR REPLACE INTO game_packs
                (pack_id,uid,player_count,questions_per_player,payload_json,status,
                 created_at,started_at,completed_at,expires_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)''', (
                    pack_id, uid, int(payload.get('playerCount') or 0),
                    int(payload.get('questionsPerPlayer') or 0), _json(payload), status,
                    str(item.get('createdAt') or payload.get('createdAt') or _utc_now()),
                    item.get('startedAt'), item.get('completedAt'),
                    str(item.get('expiresAt') or payload.get('expiresAt') or _utc_now()),
                ))
            for question in [*payload.get('questions', []),
                             *payload.get('replacements', {}).values()]:
                if not isinstance(question, dict) or not question.get('questionId'):
                    continue
                connection.execute('''INSERT OR IGNORE INTO game_pack_questions
                    (pack_id,uid,question_id,level,is_spare) VALUES (?,?,?,?,?)''', (
                        pack_id, uid, str(question['questionId']),
                        int(question.get('level') or 0), int(question.get('replacement') is True),
                    ))
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def user_state_snapshot(db_path: str, uid: str) -> dict:
    connection = _connect(db_path)
    try:
        pack_rows = connection.execute('''SELECT * FROM game_packs WHERE uid=?
            AND status IN ('queued','active','completed','cancelled')
            ORDER BY created_at DESC LIMIT 200''', (uid,)).fetchall()
        packs = [{
            'packId': row['pack_id'], 'payload': _load_json(row['payload_json'], {}),
            'status': row['status'], 'createdAt': row['created_at'],
            'startedAt': row['started_at'], 'completedAt': row['completed_at'],
            'expiresAt': row['expires_at'],
        } for row in pack_rows]
        seen = [{
            'questionId': row['question_id'], 'level': row['level'],
            'cycle': row['cycle'], 'seenAt': row['seen_at'],
        } for row in connection.execute(
            'SELECT * FROM player_question_seen WHERE uid=?', (uid,)).fetchall()]
        cycles = [{'level': row['level'], 'cycle': row['cycle']} for row in
                  connection.execute('SELECT * FROM player_question_cycles WHERE uid=?',
                                     (uid,)).fetchall()]
        return {'packs': packs, 'seen': seen, 'cycles': cycles}
    finally:
        connection.close()


def _cycle(connection, uid: str, level: int) -> int:
    connection.execute('''INSERT OR IGNORE INTO player_question_cycles(uid, level, cycle)
                          VALUES (?, ?, 1)''', (uid, level))
    return int(connection.execute('''SELECT cycle FROM player_question_cycles
                                     WHERE uid=? AND level=?''', (uid, level)).fetchone()[0])


def _available_rows(connection, uid: str, level: int, count: int) -> tuple[list, int]:
    cycle = _cycle(connection, uid, level)
    rows = connection.execute('''
        SELECT q.* FROM editorial_questions q
        WHERE q.status='approved' AND q.level=?
          AND NOT EXISTS (
            SELECT 1 FROM player_question_seen s
            WHERE s.uid=? AND s.level=q.level AND s.cycle=?
              AND s.question_id=q.question_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM game_pack_questions r JOIN game_packs p ON p.pack_id=r.pack_id
            WHERE r.uid=? AND r.question_id=q.question_id
              AND p.status IN ('queued','active') AND p.expires_at>?
          )
    ''', (level, uid, cycle, uid, _utc_now())).fetchall()
    secrets.SystemRandom().shuffle(rows)
    if len(rows) >= count:
        return rows[:count], cycle

    approved = connection.execute('''SELECT COUNT(*) FROM editorial_questions
                                      WHERE status='approved' AND level=?''', (level,)).fetchone()[0]
    reserved = connection.execute('''
        SELECT COUNT(DISTINCT r.question_id) FROM game_pack_questions r
        JOIN game_packs p ON p.pack_id=r.pack_id
        WHERE r.uid=? AND r.level=? AND p.status IN ('queued','active') AND p.expires_at>?
    ''', (uid, level, _utc_now())).fetchone()[0]
    if approved - reserved < count:
        return [], cycle
    cycle += 1
    connection.execute('''UPDATE player_question_cycles SET cycle=?
                          WHERE uid=? AND level=?''', (cycle, uid, level))
    rows = connection.execute('''
        SELECT q.* FROM editorial_questions q
        WHERE q.status='approved' AND q.level=?
          AND NOT EXISTS (
            SELECT 1 FROM game_pack_questions r JOIN game_packs p ON p.pack_id=r.pack_id
            WHERE r.uid=? AND r.question_id=q.question_id
              AND p.status IN ('queued','active') AND p.expires_at>?
          )
    ''', (level, uid, _utc_now())).fetchall()
    secrets.SystemRandom().shuffle(rows)
    return rows[:count], cycle


def _player_question(row, owner_index: int, owner_number: int, *, replacement=False) -> dict:
    options = list(_load_json(row['options_json'], []))
    indexed = list(enumerate(options))
    secrets.SystemRandom().shuffle(indexed)
    shuffled = [value for _, value in indexed]
    correct_index = next(
        index for index, (original, _) in enumerate(indexed)
        if original == row['correct_index'])
    return {
        'questionId': row['question_id'], 'question': row['prompt'],
        'options': shuffled, 'correctIndex': correct_index,
        'level': row['level'], 'points': POINTS_BY_LEVEL[row['level']],
        'ownerIndex': owner_index, 'ownerQuestionNumber': owner_number,
        'replacement': replacement,
    }


def _create_pack(connection, uid: str, player_count: int,
                 questions_per_player: int) -> dict:
    levels = difficulty_sequence(questions_per_player)
    needs = Counter(levels)
    selected_by_level = {}
    cycles = {}
    availability = {}
    # One spare for every owner at every level supports the once-per-game
    # replacement lifeline without another network request.
    for level in LEVELS:
        required = needs[level] * player_count + player_count
        rows, cycle = _available_rows(connection, uid, level, required)
        availability[str(level)] = len(rows)
        if len(rows) < required:
            raise BankNotReadyError(availability)
        selected_by_level[level] = list(rows)
        cycles[level] = cycle

    main = []
    owner_numbers = [0] * player_count
    for round_index in range(questions_per_player * player_count):
        owner = round_index % player_count
        owner_numbers[owner] += 1
        level = levels[owner_numbers[owner] - 1]
        row = selected_by_level[level].pop()
        main.append(_player_question(row, owner, owner_numbers[owner]))

    replacements = {}
    for owner in range(player_count):
        for level in LEVELS:
            row = selected_by_level[level].pop()
            replacements[f'{owner}:{level}'] = _player_question(
                row, owner, 0, replacement=True)

    pack_id = f'PACK-{uuid.uuid4().hex.upper()}'
    created_at = _utc_now()
    expires_at = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=14)).isoformat(
        timespec='seconds').replace('+00:00', 'Z')
    payload = {
        'schemaVersion': 1, 'packId': pack_id, 'playerCount': player_count,
        'questionsPerPlayer': questions_per_player, 'timerSeconds': 30,
        'questions': main, 'replacements': replacements,
        'createdAt': created_at, 'expiresAt': expires_at,
    }
    connection.execute('''INSERT INTO game_packs
        (pack_id,uid,player_count,questions_per_player,payload_json,status,created_at,expires_at)
        VALUES (?,?,?,?,?,'queued',?,?)''',
        (pack_id, uid, player_count, questions_per_player, _json(payload),
         created_at, expires_at))
    for question in [*main, *replacements.values()]:
        connection.execute('''INSERT INTO game_pack_questions
            (pack_id,uid,question_id,level,is_spare) VALUES (?,?,?,?,?)''',
            (pack_id, uid, question['questionId'], question['level'],
             int(question['replacement'])))
    return payload


def ensure_packs(db_path: str, uid: str, player_count: int,
                 questions_per_player: int, target=2, *, introductory=False) -> dict:
    try:
        players = int(player_count)
        questions = int(questions_per_player)
        desired = 1 if introductory else max(1, min(2, int(target)))
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValidationError('إعدادات الجولة غير صالحة') from exc
    if players not in (1, 2, 3):
        raise ValidationError('عدد اللاعبين يجب أن يكون من 1 إلى 3')
    difficulty_sequence(questions)
    connection = _connect(db_path)
    try:
        connection.execute("DELETE FROM game_packs WHERE status='queued' AND expires_at<=?", (_utc_now(),))
        # A free account receives exactly one playable pack. It may still change
        # setup before starting; after a pack starts, the introductory entitlement
        # can never mint another pack.
        if introductory:
            already_started = connection.execute('''SELECT 1 FROM game_packs
                WHERE uid=? AND status IN ('active','completed') LIMIT 1''',
                (uid,)).fetchone()
            if already_started:
                raise AccessDeniedError('تم استخدام الجولة التعريفية لهذا الحساب')
            connection.execute('''DELETE FROM game_packs
                WHERE uid=? AND status='queued'
                  AND (player_count<>? OR questions_per_player<>?)''',
                (uid, players, questions))
        else:
            # A changed setup invalidates only packs that have not started.
            connection.execute('''UPDATE game_packs SET status='cancelled'
                WHERE uid=? AND status='queued'
                  AND (player_count<>? OR questions_per_player<>?)''',
                (uid, players, questions))
        rows = connection.execute('''SELECT * FROM game_packs
            WHERE uid=? AND status='queued' AND player_count=?
              AND questions_per_player=? AND expires_at>?
            ORDER BY created_at''', (uid, players, questions, _utc_now())).fetchall()
        packs = [_load_json(row['payload_json'], {}) for row in rows]
        if introductory and len(rows) > 1:
            connection.executemany('DELETE FROM game_packs WHERE pack_id=?',
                                   [(row['pack_id'],) for row in rows[1:]])
            packs = packs[:1]
        while len(packs) < desired:
            packs.append(_create_pack(connection, uid, players, questions))
        connection.commit()
        return {'packs': packs[:desired], 'cachedAhead': len(packs[:desired])}
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def start_pack(db_path: str, uid: str, pack_id: str) -> dict:
    connection = _connect(db_path)
    try:
        row = connection.execute('SELECT * FROM game_packs WHERE uid=? AND pack_id=?',
                                 (uid, pack_id)).fetchone()
        if not row:
            raise NotFoundError('حزمة الجولة غير موجودة')
        if row['status'] not in {'queued', 'active'}:
            raise ValidationError('حزمة الجولة غير قابلة للبدء')
        connection.execute('''UPDATE game_packs SET status='active',
            started_at=COALESCE(started_at,?) WHERE pack_id=?''', (_utc_now(), pack_id))
        connection.commit()
        return _load_json(row['payload_json'], {})
    finally:
        connection.close()


def complete_pack(db_path: str, uid: str, pack_id: str,
                  used_replacement_ids=None, outcomes=None) -> dict:
    used_replacements = set(_clean_list(used_replacement_ids, maximum=3, item_maximum=80))
    outcome_rows = outcomes if isinstance(outcomes, list) else []
    connection = _connect(db_path)
    try:
        row = connection.execute('SELECT * FROM game_packs WHERE uid=? AND pack_id=?',
                                 (uid, pack_id)).fetchone()
        if not row:
            raise NotFoundError('حزمة الجولة غير موجودة')
        if row['status'] == 'completed':
            return {'ok': True, 'alreadyCompleted': True}
        payload = _load_json(row['payload_json'], {})
        seen_ids = {question['questionId'] for question in payload.get('questions', [])}
        seen_ids.update(used_replacements)
        levels = {question['questionId']: question['level']
                  for question in [*payload.get('questions', []),
                                   *payload.get('replacements', {}).values()]}
        now = _utc_now()
        for question_id in seen_ids:
            level = int(levels.get(question_id) or 0)
            if level not in LEVELS:
                continue
            cycle = _cycle(connection, uid, level)
            connection.execute('''INSERT OR IGNORE INTO player_question_seen
                (uid,level,cycle,question_id,seen_at) VALUES (?,?,?,?,?)''',
                (uid, level, cycle, question_id, now))
        for outcome in outcome_rows[:200]:
            if not isinstance(outcome, dict):
                continue
            question_id = str(outcome.get('questionId') or '')
            if question_id not in levels:
                continue
            connection.execute('''UPDATE editorial_questions SET
                play_count=play_count+1,
                correct_count=correct_count+? WHERE question_id=?''',
                (1 if outcome.get('answeredCorrectly') is True else 0, question_id))
        connection.execute('''UPDATE game_packs SET status='completed', completed_at=?
                              WHERE pack_id=?''', (now, pack_id))
        connection.commit()
        return {'ok': True, 'seenCount': len(seen_ids)}
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def create_report(db_path: str, uid: str, reporter: dict, data: dict) -> dict:
    question_id = str(data.get('questionId') or '').strip()[:80]
    reason = str(data.get('reason') or '').strip()
    details = str(data.get('details') or '').strip()[:1000]
    if reason not in REPORT_REASONS:
        raise ValidationError('سبب البلاغ غير صالح')
    connection = _connect(db_path)
    try:
        row = connection.execute('SELECT * FROM editorial_questions WHERE question_id=?',
                                 (question_id,)).fetchone()
        if not row:
            raise NotFoundError('السؤال غير موجود')
        internal = _row_to_question(row)
        snapshot = {
            'questionId': internal['questionId'], 'prompt': internal['prompt'],
            'options': internal['options'], 'correctIndex': internal['correctIndex'],
            'correctAnswer': internal['options'][internal['correctIndex']],
            'level': internal['level'], 'topic': internal['topic'],
            'sources': internal['sources'], 'correctReason': internal['correctReason'],
            'distractorReasons': internal['distractorReasons'],
        }
        report_id = f'REPORT-{uuid.uuid4().hex.upper()}'
        connection.execute('''INSERT INTO player_question_reports
            (report_id,uid,reporter_name,reporter_email,question_id,
             question_snapshot_json,selections_json,reason,details,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)''', (
                report_id, uid, str(reporter.get('name') or '')[:100],
                str(reporter.get('email') or '')[:240], question_id,
                _json(snapshot), _json(data.get('selections') or []), reason,
                details, _utc_now()))
        connection.execute('''UPDATE editorial_questions
            SET report_count=report_count+1 WHERE question_id=?''', (question_id,))
        connection.commit()
        return {'reportId': report_id, 'emailStatus': 'pending'}
    finally:
        connection.close()


def pending_report(db_path: str, report_id: str) -> dict:
    connection = _connect(db_path)
    try:
        row = connection.execute('''SELECT * FROM player_question_reports
                                    WHERE report_id=?''', (report_id,)).fetchone()
        if not row:
            raise NotFoundError('البلاغ غير موجود')
        result = dict(row)
        result['question'] = _load_json(result.pop('question_snapshot_json'), {})
        result['selections'] = _load_json(result.pop('selections_json'), [])
        return result
    finally:
        connection.close()


def set_report_email_status(db_path: str, report_id: str, status: str) -> None:
    connection = _connect(db_path)
    try:
        connection.execute('''UPDATE player_question_reports SET email_status=?
                              WHERE report_id=?''', (status[:40], report_id))
        connection.commit()
    finally:
        connection.close()


def list_reports(db_path: str, limit=100) -> list[dict]:
    connection = _connect(db_path)
    try:
        rows = connection.execute('''SELECT * FROM player_question_reports
            ORDER BY created_at DESC LIMIT ?''', (max(1, min(250, int(limit))),)).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item['question'] = _load_json(item.pop('question_snapshot_json'), {})
            item['selections'] = _load_json(item.pop('selections_json'), [])
            result.append(item)
        return result
    finally:
        connection.close()


def cache_reports(db_path: str, documents) -> int:
    rows = [item for item in (documents or []) if isinstance(item, dict)]
    connection = _connect(db_path)
    try:
        for item in rows:
            report_id = str(item.get('report_id') or item.get('reportId')
                            or item.get('_document_id') or '')
            question = item.get('question') if isinstance(item.get('question'), dict) else {}
            if not report_id or not question:
                continue
            connection.execute('''INSERT OR REPLACE INTO player_question_reports
                (report_id,uid,reporter_name,reporter_email,question_id,
                 question_snapshot_json,selections_json,reason,details,email_status,
                 created_at,resolved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)''', (
                    report_id, str(item.get('uid') or ''),
                    str(item.get('reporter_name') or item.get('reporterName') or '')[:100],
                    str(item.get('reporter_email') or item.get('reporterEmail') or '')[:240],
                    str(item.get('question_id') or item.get('questionId')
                        or question.get('questionId') or ''),
                    _json(question), _json(item.get('selections') or []),
                    str(item.get('reason') or 'other'), str(item.get('details') or '')[:1000],
                    str(item.get('email_status') or item.get('emailStatus') or 'pending'),
                    str(item.get('created_at') or item.get('createdAt') or _utc_now()),
                    item.get('resolved_at') or item.get('resolvedAt'),
                ))
        connection.commit()
        return len(rows)
    finally:
        connection.close()


def resolve_report(db_path: str, report_id: str, *, resolved: bool) -> dict:
    connection = _connect(db_path)
    try:
        row = connection.execute(
            'SELECT 1 FROM player_question_reports WHERE report_id=?',
            (report_id,)).fetchone()
        if not row:
            raise NotFoundError('البلاغ غير موجود')
        connection.execute('UPDATE player_question_reports SET resolved_at=? WHERE report_id=?',
                           (_utc_now() if resolved else None, report_id))
        connection.commit()
        return pending_report(db_path, report_id)
    finally:
        connection.close()
