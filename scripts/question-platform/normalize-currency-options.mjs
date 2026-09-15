import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

const GENERIC_CURRENCIES = [
  'دولار', 'يورو', 'دينار', 'ريال', 'درهم', 'جنيه', 'ين', 'يوان',
  'روبية', 'بيزو', 'فرنك', 'ليرة', 'روبل', 'وون', 'كرونة', 'شلن',
  'راند', 'زلوتي', 'هريفنا', 'نيرة', 'بات', 'دونغ', 'تاكا', 'أفغاني',
  'كواشا', 'كوانزا', 'بوليفار', 'سول', 'فورنت', 'ليو', 'مانات', 'تينغ',
  'بولا', 'بير', 'كيات', 'كيب', 'جوردة', 'غواراني', 'كوردوبا', 'كتزال',
  'لمبيرة', 'أوقية', 'دالاسي', 'ساماني', 'سوم', 'درام', 'لاري', 'ليك',
  'سيدي', 'أرياري', 'نقفة', 'نغولترم', 'روفية', 'دوبرا', 'تالا', 'بانغا',
  'فاتو', 'إيسكودو', 'ليلانغيني', 'توغروغ', 'كينا', 'بوليفيانو',
  'ليون', 'بيسو', 'كولون', 'ميتيكال',
];

const SPECIAL_NAMES = new Map([
  ['بوتسوانا بولا', 'بولا'],
  ['رنمينبي', 'يوان'],
  ['زواتي بولندي', 'زلوتي'],
  ['تنك قزاقستاني', 'تينغ'],
  ['مثقال موزنبيقي', 'ميتيكال'],
  ['لو ملداوي', 'ليو'],
  ['منات تركمانستاني', 'مانات'],
  ['روبي موريشي', 'روبية'],
  ['بانجا تونجي', 'بانغا'],
  ['كوردبا نيكاراغوا', 'كوردوبا'],
]);

function genericCurrencyName(value) {
  const clean = String(value || '').trim();
  if (SPECIAL_NAMES.has(clean)) return SPECIAL_NAMES.get(clean);
  const firstWord = clean.split(/\s+/u)[0];
  if (!firstWord) throw new Error(`Empty currency option: ${value}`);
  return firstWord;
}

function stableSeed(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeOptions(questionId, options, correctIndex) {
  const correct = genericCurrencyName(options[correctIndex]);
  const normalized = new Array(4);
  normalized[correctIndex] = correct;
  const used = new Set([correct]);
  let poolCursor = stableSeed(questionId) % GENERIC_CURRENCIES.length;

  for (let index = 0; index < options.length; index += 1) {
    if (index === correctIndex) continue;
    let candidate = genericCurrencyName(options[index]);
    if (used.has(candidate)) {
      for (let attempt = 0; attempt < GENERIC_CURRENCIES.length; attempt += 1) {
        candidate = GENERIC_CURRENCIES[poolCursor % GENERIC_CURRENCIES.length];
        poolCursor += 1;
        if (!used.has(candidate)) break;
      }
    }
    if (used.has(candidate)) throw new Error(`Could not create unique options for ${questionId}`);
    normalized[index] = candidate;
    used.add(candidate);
  }
  return normalized;
}

function updateDatabase(databasePath) {
  const database = new DatabaseSync(resolve(databasePath));
  const questions = database.prepare(`
    SELECT question_id, options_json, correct_index, verification_notes_json
    FROM editorial_questions
    WHERE prompt LIKE 'ما العملة الرسمية المستخدمة في %'
    ORDER BY question_id
  `).all();
  const update = database.prepare(`
    UPDATE editorial_questions
    SET options_json = ?, correct_reason = ?, distractor_reasons_json = ?,
        verification_notes_json = ?, version = version + 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE question_id = ?
  `);

  database.exec('BEGIN IMMEDIATE');
  try {
    for (const question of questions) {
      const options = JSON.parse(question.options_json);
      const normalized = normalizeOptions(question.question_id, options, Number(question.correct_index));
      const correct = normalized[question.correct_index];
      const reasons = normalized.map((option, index) => index === question.correct_index
        ? `${option} هو اسم العملة الصحيح وفق المصدرين المرفقين.`
        : `${option} ليس اسم العملة الصحيحة للدولة الواردة في السؤال.`);
      const notes = JSON.parse(question.verification_notes_json || '[]');
      const reviewNote = 'رُوجعت الخيارات وحُذفت منها أسماء الدول والصفات التي قد تكشف الإجابة.';
      if (!notes.includes(reviewNote)) notes.push(reviewNote);
      update.run(
        JSON.stringify(normalized),
        `الإجابة الصحيحة هي ${correct} وفق المصدرين المرفقين.`,
        JSON.stringify(reasons),
        JSON.stringify(notes),
        question.question_id,
      );
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    database.close();
    throw error;
  }

  const audited = database.prepare(`
    SELECT question_id, options_json, correct_index
    FROM editorial_questions
    WHERE prompt LIKE 'ما العملة الرسمية المستخدمة في %'
  `).all();
  for (const question of audited) {
    const options = JSON.parse(question.options_json);
    if (options.length !== 4 || new Set(options).size !== 4) {
      throw new Error(`Invalid normalized options for ${question.question_id}`);
    }
    if (options.some(option => /\s/u.test(option.trim()))) {
      throw new Error(`A revealing multi-word currency remains in ${question.question_id}`);
    }
    if (!options[question.correct_index]) throw new Error(`Missing correct answer for ${question.question_id}`);
  }
  database.close();
  return questions.length;
}

const databasePaths = process.argv.slice(2);
if (!databasePaths.length) throw new Error('Pass at least one SQLite database path.');
for (const databasePath of databasePaths) {
  const count = updateDatabase(databasePath);
  console.log(`Normalized ${count} currency questions in ${databasePath}.`);
}
