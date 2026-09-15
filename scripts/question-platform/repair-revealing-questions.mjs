import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

const ITU_SOURCE = {
  title: 'الاتحاد الدولي للاتصالات: موارد الترقيم الدولي',
  url: 'https://www.itu.int/en/ITU-T/inr/Pages/default.aspx',
  license: '',
  accessedAt: '2026-09-11',
};
const UN_REGION_SOURCE = {
  title: 'الأمم المتحدة: معيار المناطق الجغرافية M49',
  url: 'https://unstats.un.org/unsd/methodology/m49/',
  license: '',
  accessedAt: '2026-09-11',
};
const GERMAN_UNITY_SOURCE = {
  title: 'الحكومة الألمانية: يوم الوحدة الألمانية 1990',
  url: 'https://www.bundesregierung.de/breg-de/schwerpunkte/deutsche-einheit/die-einheit-ist-wirklichkeit-432814',
  license: '',
  accessedAt: '2026-09-11',
};

const repairs = {
  'FAT-002-054': ['ما مفتاح الاتصال الدولي للجزائر؟', ['+212', '+213', '+216', '+218'], 1, ITU_SOURCE],
  'FAT-002-093': ['في أي منطقة من أفريقيا تقع الجزائر؟', ['شرق أفريقيا', 'غرب أفريقيا', 'شمال أفريقيا', 'وسط أفريقيا'], 2, UN_REGION_SOURCE],
  'FAT-002-161': ['ما مفتاح الاتصال الدولي لغواتيمالا؟', ['+503', '+502', '+505', '+504'], 1, ITU_SOURCE],
  'FAT-002-199': ['في أي منطقة من الأمريكتين تقع غواتيمالا؟', ['أمريكا الجنوبية', 'أمريكا الوسطى', 'منطقة الكاريبي', 'أمريكا الشمالية'], 1, UN_REGION_SOURCE],
  'FAT-002-172': ['أي مدينة كانت عاصمة ألمانيا الشرقية؟', ['براغ', 'بودابست', 'وارسو', 'برلين'], 3, GERMAN_UNITY_SOURCE],
  'FAT-002-210': ['في أي عام انتهى وجود ألمانيا الشرقية مع إعادة توحيد ألمانيا؟', ['1989', '1991', '1990', '1993'], 2, GERMAN_UNITY_SOURCE],
  'FAT-002-194': ['ما مفتاح الاتصال الدولي لتونس؟', ['+213', '+216', '+218', '+212'], 1, ITU_SOURCE],
  'FAT-002-232': ['في أي منطقة من أفريقيا تقع تونس؟', ['غرب أفريقيا', 'وسط أفريقيا', 'شمال أفريقيا', 'شرق أفريقيا'], 2, UN_REGION_SOURCE],
  'FAT-002-282': ['ما مفتاح الاتصال الدولي لسنغافورة؟', ['+60', '+62', '+65', '+66'], 2, ITU_SOURCE],
  'FAT-002-318': ['في أي منطقة من آسيا تقع سنغافورة؟', ['جنوب آسيا', 'غرب آسيا', 'جنوب شرق آسيا', 'شرق آسيا'], 2, UN_REGION_SOURCE],
  'FAT-002-313': ['ما مفتاح الاتصال الدولي لبنما؟', ['+505', '+506', '+507', '+502'], 2, ITU_SOURCE],
  'FAT-002-351': ['في أي منطقة من الأمريكتين تقع بنما؟', ['أمريكا الوسطى', 'أمريكا الجنوبية', 'منطقة الكاريبي', 'أمريكا الشمالية'], 0, UN_REGION_SOURCE],
  'FAT-002-316': ['ما مفتاح الاتصال الدولي للكويت؟', ['+971', '+974', '+965', '+968'], 2, ITU_SOURCE],
  'FAT-002-354': ['في أي منطقة من آسيا تقع الكويت؟', ['وسط آسيا', 'جنوب آسيا', 'غرب آسيا', 'شرق آسيا'], 2, UN_REGION_SOURCE],
  'FAT-002-369': ['ما مفتاح الاتصال الدولي لغينيا بيساو؟', ['+224', '+245', '+238', '+240'], 1, ITU_SOURCE],
  'FAT-002-408': ['في أي منطقة من أفريقيا تقع غينيا بيساو؟', ['شرق أفريقيا', 'غرب أفريقيا', 'وسط أفريقيا', 'شمال أفريقيا'], 1, UN_REGION_SOURCE],
  'FAT-002-400': ['ما مفتاح الاتصال الدولي لجيبوتي؟', ['+251', '+252', '+253', '+254'], 2, ITU_SOURCE],
  'FAT-002-438': ['في أي منطقة من أفريقيا تقع جيبوتي؟', ['غرب أفريقيا', 'شرق أفريقيا', 'وسط أفريقيا', 'جنوب أفريقيا'], 1, UN_REGION_SOURCE],
  'FAT-002-414': ['ما مفتاح الاتصال الدولي للوكسمبورغ؟', ['+351', '+352', '+353', '+354'], 1, ITU_SOURCE],
  'FAT-002-452': ['في أي منطقة من أوروبا تقع لوكسمبورغ؟', ['شمال أوروبا', 'غرب أوروبا', 'شرق أوروبا', 'جنوب أوروبا'], 1, UN_REGION_SOURCE],
  'FAT-002-450': ['ما مفتاح الاتصال الدولي لساو تومي وبرينسيب؟', ['+238', '+239', '+240', '+241'], 1, ITU_SOURCE],
  'FAT-002-488': ['في أي منطقة من أفريقيا تقع ساو تومي وبرينسيب؟', ['شرق أفريقيا', 'شمال أفريقيا', 'وسط أفريقيا', 'جنوب أفريقيا'], 2, UN_REGION_SOURCE],
  'FAT-002-475': ['ما مفتاح الاتصال الدولي لأندورا؟', ['+374', '+375', '+376', '+377'], 2, ITU_SOURCE],
  'FAT-002-489': ['ما مفتاح الاتصال الدولي لموناكو؟', ['+376', '+377', '+378', '+379'], 1, ITU_SOURCE],
  'FAT-002-518': ['في أي منطقة من أوروبا تقع موناكو؟', ['شرق أوروبا', 'شمال أوروبا', 'غرب أوروبا', 'جنوب أوروبا'], 2, UN_REGION_SOURCE],
  'FAT-002-494': ['ما مفتاح الاتصال الدولي لسان مارينو؟', ['+376', '+377', '+378', '+379'], 2, ITU_SOURCE],
  'FAT-002-522': ['في أي منطقة من أوروبا تقع سان مارينو؟', ['غرب أوروبا', 'شرق أوروبا', 'شمال أوروبا', 'جنوب أوروبا'], 3, UN_REGION_SOURCE],
};

function updateDatabase(databasePath) {
  const database = new DatabaseSync(resolve(databasePath));
  const select = database.prepare('SELECT sources_json, verification_notes_json FROM editorial_questions WHERE question_id = ?');
  const update = database.prepare(`
    UPDATE editorial_questions
    SET prompt = ?, options_json = ?, correct_index = ?, correct_reason = ?,
        distractor_reasons_json = ?, sources_json = ?, verification_notes_json = ?,
        version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE question_id = ?
  `);
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const [questionId, [prompt, options, correctIndex, authority]] of Object.entries(repairs)) {
      const current = select.get(questionId);
      if (!current) throw new Error(`Missing question ${questionId}`);
      const sources = JSON.parse(current.sources_json || '[]').filter(source => source?.url !== authority.url);
      sources.push(authority);
      const notes = JSON.parse(current.verification_notes_json || '[]');
      const note = 'أُعيدت صياغة السؤال وخياراته لمنع كشف الإجابة من تشابه الألفاظ.';
      if (!notes.includes(note)) notes.push(note);
      const answer = options[correctIndex];
      const reasons = options.map((option, index) => index === correctIndex
        ? `${option} هو الجواب الصحيح وفق المصادر المرفقة.`
        : `${option} لا يطابق الحقيقة المطلوبة في السؤال.`);
      update.run(
        prompt,
        JSON.stringify(options),
        correctIndex,
        `الإجابة الصحيحة هي ${answer} وفق المصادر المرفقة.`,
        JSON.stringify(reasons),
        JSON.stringify(sources),
        JSON.stringify(notes),
        questionId,
      );
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    database.close();
    throw error;
  }
  database.close();
  return Object.keys(repairs).length;
}

const databasePaths = process.argv.slice(2);
if (!databasePaths.length) throw new Error('Pass at least one SQLite database path.');
for (const databasePath of databasePaths) {
  console.log(`Repaired ${updateDatabase(databasePath)} revealing questions in ${databasePath}.`);
}
