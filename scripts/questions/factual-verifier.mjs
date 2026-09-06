import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEXT_RELEASE_REVIEW_DATE } from './categories/common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const POLICY_PATH = path.join(ROOT, 'content/questions/source-policy.json');

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function same(left, right) {
  return canonical(left) === canonical(right);
}

function normalizedChoice(value) {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase()
    .replace(/[\u064b-\u065f\u0670]/gu, '')
    .replace(/[إأآٱ]/gu, 'ا')
    .replace(/ى/gu, 'ي')
    .replace(/ة/gu, 'ه')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function verifyQuestionStructure(question) {
  if (!question || !/^gq-[a-f0-9]{20}$/u.test(String(question.id || ''))
      || typeof question.q !== 'string' || question.q.trim().length < 12 || question.q.trim().length > 220
      || typeof question.answer !== 'string' || !question.answer.trim() || question.answer.trim().length > 140
      || typeof question.sourceRecordId !== 'string' || !question.sourceRecordId
      || typeof question.factKey !== 'string' || !question.factKey
      || !Number.isInteger(question.d) || question.d < 1 || question.d > 6
      || question.band !== (question.d <= 2 ? 'easy' : question.d <= 4 ? 'medium' : 'hard')
      || !Array.isArray(question.o) || question.o.length !== 4
      || !Number.isInteger(question.a) || question.a < 0 || question.a > 3
      || question.o.some(option => typeof option !== 'string' || !option.trim())
      || question.o[question.a] !== question.answer) return false;
  const normalized = question.o.map(normalizedChoice);
  return new Set(normalized).size === 4
    && normalized.filter(option => option === normalizedChoice(question.answer)).length === 1;
}

function valueAt(document, dottedPath) {
  return String(dottedPath || '').split('.').filter(Boolean)
    .reduce((value, key) => value?.[key], document);
}

function readArtifact(relativePath) {
  const normalized = path.posix.normalize(String(relativePath || '').replaceAll('\\', '/'));
  if (!normalized.startsWith('content/questions/structured-sources/') || normalized.includes('../')) {
    throw new Error(`مسار دليل غير مسموح: ${relativePath}`);
  }
  const absolutePath = path.join(ROOT, normalized);
  const bytes = fs.readFileSync(absolutePath);
  return { document: JSON.parse(bytes.toString('utf8')), sha256: hash(bytes), relativePath: normalized };
}

function trustedHosts() {
  const policy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
  return new Set([
    ...(policy.generalTrustedHosts || []),
    'unicode.org', 'www.unicode.org', 'iupac.org', 'www.iupac.org',
    'bipm.org', 'www.bipm.org',
    'plato.stanford.edu', 'api.fifa.com', 'www.wikidata.org', 'query.wikidata.org',
    'ar.wikipedia.org', 'www.wikipedia.org', 'ar.wikiquote.org',
  ]);
}

function verifySourceUrl(question, allowedHosts) {
  let parsed;
  try { parsed = new URL(question.source?.url); }
  catch { throw new Error(`${question.id}: رابط المصدر غير صالح`); }
  const hostname = parsed.hostname.toLowerCase();
  const trusted = [...allowedHosts].some(host => hostname === host || hostname.endsWith(`.${host}`));
  if (parsed.protocol !== 'https:' || !trusted) {
    throw new Error(`${question.id}: مضيف المصدر غير معتمد: ${parsed.hostname}`);
  }
  return parsed.href;
}

function resolveSourceRecord(question, sourceArtifactCache) {
  const verification = question.verification;
  let artifact = sourceArtifactCache.get(verification.artifact);
  if (!artifact) {
    artifact = readArtifact(verification.artifact);
    sourceArtifactCache.set(artifact.relativePath, artifact);
  }
  const collection = valueAt(artifact.document, verification.collection || 'records');
  if (!Array.isArray(collection)) throw new Error(`${question.id}: مجموعة الدليل غير موجودة`);
  const record = collection.find(item => String(item?.[verification.recordIdField]) === String(verification.recordId));
  if (!record) throw new Error(`${question.id}: سجل الدليل غير موجود`);
  for (const [field, expected] of Object.entries(verification.fields || {})) {
    if (!same(valueAt(record, field), expected)) {
      throw new Error(`${question.id}: الحقل ${field} لا يطابق لقطة المصدر`);
    }
  }
  return { artifact, record };
}

function resolveSourceRecordSet(question, sourceArtifactCache) {
  const verification = question.verification;
  let artifact = sourceArtifactCache.get(verification.artifact);
  if (!artifact) {
    artifact = readArtifact(verification.artifact);
    sourceArtifactCache.set(artifact.relativePath, artifact);
  }
  const collection = valueAt(artifact.document, verification.collection || 'records');
  if (!Array.isArray(collection) || !Array.isArray(verification.records) || verification.records.length !== 4) {
    throw new Error(`${question.id}: مجموعة الأدلة المتعددة غير صالحة`);
  }
  const records = verification.records.map(specification => {
    const record = collection.find(item => String(item?.[verification.recordIdField]) === String(specification.recordId));
    if (!record) throw new Error(`${question.id}: سجل دليل متعدد غير موجود`);
    for (const [field, expected] of Object.entries(specification.fields || {})) {
      if (!same(valueAt(record, field), expected)) {
        throw new Error(`${question.id}: الحقل المتعدد ${field} لا يطابق لقطة المصدر`);
      }
    }
    return record;
  });
  return { artifact, records };
}

const animalGroups = {
  Mammalia: 'الثدييات', Aves: 'الطيور', Reptilia: 'الزواحف',
  Actinopterygii: 'الأسماك شعاعية الزعانف', Amphibia: 'البرمائيات',
  Insecta: 'الحشرات', Mollusca: 'الرخويات', Arachnida: 'العنكبيات',
};

function verifyKnownTemplate(question, record) {
  const template = question.templateId;
  const exact = (q, answer) => question.q === q && question.answer === String(answer);
  const elementName = value => String(value || '').startsWith('ال') ? String(value) : `ال${value}`;
  const animalName = value => ({
    'عقاب ذهبية': 'عقاب ذهبي',
    'وحيد قرن هندي': 'وحيد القرن الهندي',
    'وَمْبَت شائع': 'ومبت شائع',
    'شمبانزي شائع': 'شمبانزي',
    'راكون شائع': 'راكون',
    'نحل العسل الغربي': 'نحل العسل',
  })[value] || value;
  if (template === 'country-capital-completion-v2') {
    return exact(`أي عاصمة تجعل هذه العبارة صحيحة: «عاصمة ${record.countryAr} هي …»؟`, record.capitalAr);
  }
  if (template === 'capital-country-v2') {
    return exact(`ما الدولة التي عاصمتها «${record.capitalAr}»؟`, record.countryAr);
  }
  if (template === 'cldr-currency-name-v1') {
    return exact(`ما العملة التي يرمز لها دوليًا بالرمز ${record.code}؟`, record.nameAr);
  }
  if (template === 'element-symbol-v2') {
    return exact(`ما الرمز الكيميائي لعنصر «${elementName(record.itemLabel)}»؟`, record.symbol);
  }
  if (template === 'element-atomic-number-v2') {
    return exact(`ما العدد الذري لعنصر «${elementName(record.itemLabel)}»؟`, record.atomicNumber);
  }
  if (template === 'animal-group-v2') {
    return exact(`إلى أي مجموعة حيوانية ينتمي «${animalName(record.commonNameAr)}»؟`, animalGroups[record.iconicTaxon]);
  }
  if (template === 'animal-scientific-name-v2') {
    return exact(`ما الاسم العلمي للحيوان «${animalName(record.commonNameAr)}»؟`, record.scientificName);
  }
  if (template === 'animal-arabic-name-v2') {
    return exact(`ما الاسم العربي للحيوان ذي الاسم العلمي «${record.scientificName}»؟`, animalName(record.commonNameAr));
  }
  if (template === 'arabic-proverb-last-word-v2') {
    const words = String(record.proverb || '').trim().split(/\s+/u);
    const answer = words.pop();
    return exact(`اكتشف الكلمة الناقصة من المثل: «${words.join(' ')} …»`, answer);
  }
  if (template?.startsWith('fifa-final-')) {
    const teamLabel = team => team === 'جمهورية ألمانيا الاتحادية' ? 'ألمانيا الغربية' : team;
    const opponents = `${teamLabel(record.homeTeam)} و${teamLabel(record.awayTeam)}`;
    const prompts = {
      champion: `أي منتخب فاز بكأس العالم عام ${record.year}؟`,
      'runner-up': `أي منتخب حلّ وصيفًا في كأس العالم عام ${record.year}؟`,
      score: `ما نتيجة نهائي كأس العالم ${record.year} بين ${opponents}، قبل ركلات الترجيح إن وُجدت؟`,
      city: `في أي مدينة أقيم نهائي كأس العالم ${record.year} بين ${opponents}؟`,
      stadium: `على أي ملعب أقيم نهائي كأس العالم ${record.year} بين ${opponents}؟`,
      date: `ما التاريخ الكامل لنهائي كأس العالم ${record.year}؟`,
    };
    const answer = ['champion', 'runner-up'].includes(record.factType)
      ? teamLabel(record.answer) : record.answer;
    return exact(prompts[record.factType], answer);
  }
  return null;
}

function verifyLogic(question) {
  const claim = question.verification?.claim;
  const suspects = claim?.suspects;
  const statements = claim?.statements;
  if (question.templateId !== 'detective-unique-solution-v3'
      || !Array.isArray(suspects) || suspects.length !== 4 || new Set(suspects).size !== 4
      || !Array.isArray(statements) || statements.length !== 4
      || ![1, 2, 3].includes(claim.requiredTrueStatements)) return false;
  const validIndex = value => Number.isInteger(value) && value >= 0 && value < 4;
  if (statements.some((statement, speaker) => {
    if (statement?.speaker !== speaker || !['guilty', 'innocent', 'oneOf', 'neither'].includes(statement?.kind)) return true;
    if (statement.kind === 'guilty' || statement.kind === 'innocent') return !validIndex(statement.subject);
    return !validIndex(statement.first) || !validIndex(statement.second) || statement.first >= statement.second;
  })) return false;
  const evaluatesTrue = (statement, culprit) => {
    // v2 single-literal puzzles are retained for backwards compatibility with
    // archived ledgers; v3 adds explicit compound claim kinds.
    if (!statement.kind) return statement.claimsGuilty
      ? statement.subject === culprit : statement.subject !== culprit;
    if (statement.kind === 'guilty') return statement.subject === culprit;
    if (statement.kind === 'innocent') return statement.subject !== culprit;
    if (statement.kind === 'oneOf') return statement.first === culprit || statement.second === culprit;
    if (statement.kind === 'neither') return statement.first !== culprit && statement.second !== culprit;
    return false;
  };
  const solutions = [0, 1, 2, 3].filter(culprit => statements.reduce((count, statement) =>
    count + Number(evaluatesTrue(statement, culprit)), 0) === claim.requiredTrueStatements);
  if (solutions.length !== 1 || solutions[0] !== claim.solution) return false;

  const statementText = statement => {
    if (statement.kind === 'guilty') return `${suspects[statement.subject]} هو السارق`;
    if (statement.kind === 'innocent') return `${suspects[statement.subject]} بريء`;
    if (statement.kind === 'oneOf') return `السارق إما ${suspects[statement.first]} وإما ${suspects[statement.second]}`;
    return `السارق ليس ${suspects[statement.first]} ولا ${suspects[statement.second]}`;
  };
  const spoken = statements.map(statement => `${suspects[statement.speaker]}: «${statementText(statement)}»`).join('؛ ');
  const truthText = claim.requiredTrueStatements === 1 ? 'قول واحد فقط صحيح'
    : claim.requiredTrueStatements === 2 ? 'قولان فقط صحيحان' : 'ثلاثة أقوال فقط صحيحة';
  const expectedQuestion = `قال أربعة مشتبهين في سرقة: ${spoken}. ${truthText}؛ من السارق؟`;

  const mappings = [];
  const buildMappings = (remaining, chosen = []) => {
    if (!remaining.length) mappings.push(chosen);
    else remaining.forEach((value, index) => buildMappings(
      [...remaining.slice(0, index), ...remaining.slice(index + 1)], [...chosen, value],
    ));
  };
  buildMappings([0, 1, 2, 3]);
  let canonicalPuzzle = null;
  for (const mapping of mappings) {
    const rows = statements.map((statement, speaker) => {
      if (statement.kind === 'guilty' || statement.kind === 'innocent') {
        return { speaker: mapping[speaker], text: `${statement.kind}:${mapping[statement.subject]}` };
      }
      let first = mapping[statement.first];
      let second = mapping[statement.second];
      if (first > second) [first, second] = [second, first];
      return { speaker: mapping[speaker], text: `${statement.kind}:${first},${second}` };
    }).sort((left, right) => left.speaker - right.speaker);
    const signature = `${claim.requiredTrueStatements}|${rows.map(row => row.text).join(';')}`;
    if (canonicalPuzzle === null || signature < canonicalPuzzle) canonicalPuzzle = signature;
  }
  const recordId = `logic-${hash(canonicalPuzzle).slice(0, 20)}`;
  const factKey = `logic:${hash(canonicalPuzzle).slice(0, 20)}`;
  const statementKindCounts = Object.fromEntries(['guilty', 'innocent', 'oneOf', 'neither']
    .map(kind => [kind, statements.filter(statement => statement.kind === kind).length]));
  const compoundStatementCount = statementKindCounts.oneOf + statementKindCounts.neither;
  const expectedBand = compoundStatementCount === 0 ? 'easy'
    : compoundStatementCount === 2 ? 'medium' : compoundStatementCount === 4 ? 'hard' : null;
  return question.q === expectedQuestion
    && question.answer === suspects[solutions[0]]
    && new Set(question.o).size === 4
    && question.o.every(option => suspects.includes(option))
    && suspects.every(suspect => question.o.includes(suspect))
    && question.sourceRecordId === recordId
    && question.factKey === factKey
    && question.source?.title === 'المنطق القضوي الكلاسيكي'
    && question.source?.url === 'https://plato.stanford.edu/entries/logic-classical/'
    && question.source?.publisher === 'Stanford Encyclopedia of Philosophy'
    && question.source?.license === 'Reference use'
    && same(question.logicSuspects, suspects)
    && same(question.logicStatements, statements)
    && question.requiredTrueStatements === claim.requiredTrueStatements
    && question.canonicalLogicStructure === canonicalPuzzle
    && question.band === expectedBand
    && same(question.logicComplexity, { compoundStatementCount, statementKindCounts })
    && same(question.verification, { profile: 'logic_unique_solution_v1', claim });
}

function contentDigest(categories) {
  return hash(Buffer.from(canonical(Object.entries(categories).flatMap(([category, rows]) => rows.map(question => {
    const payload = { ...question, category };
    delete payload.review;
    return payload;
  })))));
}

function verifierBundleDigest(verifierFiles = []) {
  const verifierInputs = [fileURLToPath(import.meta.url), ...verifierFiles.map(file => path.join(ROOT, file))];
  return hash(Buffer.concat(verifierInputs.map(file => fs.readFileSync(file))));
}

function questionDigest(category, question) {
  const payload = { ...question, category };
  delete payload.review;
  return hash(Buffer.from(canonical(payload)));
}

function claimDigest(category, question) {
  return hash(Buffer.from(canonical({
    category, q: question.q, answer: question.answer,
    sourceRecordId: question.sourceRecordId, factKey: question.factKey,
    templateId: question.templateId,
    claim: question.verification?.claim,
  })));
}

function expectedLedgerEvidence(question, artifactHashes) {
  let url;
  try { url = new URL(question.source?.url).href; } catch { return null; }
  const verification = question.verification || {};
  const evidenceForRecord = specification => ({
    artifact: verification.artifact,
    artifactSha256: artifactHashes?.[verification.artifact],
    recordIdField: verification.recordIdField,
    recordId: specification.recordId,
    url,
  });
  if (verification.profile === 'source_record_fields_v1') {
    return [evidenceForRecord({ recordId: verification.recordId })];
  }
  if (verification.profile === 'source_record_set_v1') {
    if (!Array.isArray(verification.records)) return null;
    return verification.records.map(evidenceForRecord);
  }
  if (verification.profile === 'logic_unique_solution_v1') {
    return [{ url, proof: 'exhaustive_four_candidate_solver' }];
  }
  const artifacts = Array.isArray(verification.artifacts) ? verification.artifacts : [];
  return artifacts.length ? artifacts.map(artifact => ({
    artifact, artifactSha256: artifactHashes?.[artifact], url,
  })) : [{ url }];
}

export function verifyQuestionBankFacts(categories, { customVerifier = null, verifierFiles = [] } = {}) {
  const allowedHosts = trustedHosts();
  const questions = Object.entries(categories).flatMap(([category, rows]) => rows.map(question => ({ category, ...question })));
  const entries = {};
  const artifactCache = new Map();
  const sourceArtifactCache = new Map();
  for (const question of questions) {
    if (!verifyQuestionStructure(question)) {
      throw new Error(`${question.id || 'question-without-id'}: بنية السؤال أو موضع الإجابة غير صالح`);
    }
    const evidenceUrl = verifySourceUrl(question, allowedHosts);
    let verified = false;
    let evidence = [];
    if (question.verification?.profile === 'source_record_fields_v1') {
      const { artifact, record } = resolveSourceRecord(question, sourceArtifactCache);
      artifactCache.set(artifact.relativePath, artifact.sha256);
      const known = verifyKnownTemplate(question, record);
      const custom = customVerifier ? customVerifier(question, record) : null;
      // A category verifier may add stricter provenance checks to a built-in
      // template. Returning false is an explicit veto; null means no extra rule.
      verified = known === true ? custom !== false : known === null && custom === true;
      evidence = [{
        artifact: artifact.relativePath,
        artifactSha256: artifact.sha256,
        recordIdField: question.verification.recordIdField,
        recordId: question.verification.recordId,
        url: evidenceUrl,
      }];
    } else if (question.verification?.profile === 'source_record_set_v1') {
      const { artifact, records } = resolveSourceRecordSet(question, sourceArtifactCache);
      artifactCache.set(artifact.relativePath, artifact.sha256);
      verified = customVerifier ? customVerifier(question, records) === true : false;
      evidence = question.verification.records.map(specification => ({
        artifact: artifact.relativePath,
        artifactSha256: artifact.sha256,
        recordIdField: question.verification.recordIdField,
        recordId: specification.recordId,
        url: evidenceUrl,
      }));
    } else if (question.verification?.profile === 'logic_unique_solution_v1') {
      const custom = customVerifier ? customVerifier(question, null) : null;
      verified = verifyLogic(question) && custom !== false;
      evidence = [{ url: evidenceUrl, proof: 'exhaustive_four_candidate_solver' }];
    } else if (customVerifier) {
      verified = customVerifier(question, null) === true;
      for (const relativePath of question.verification?.artifacts || []) {
        const artifact = readArtifact(relativePath);
        artifactCache.set(artifact.relativePath, artifact.sha256);
        evidence.push({ artifact: artifact.relativePath, artifactSha256: artifact.sha256, url: evidenceUrl });
      }
      if (!evidence.length) evidence.push({ url: evidenceUrl });
    }
    if (!verified) throw new Error(`${question.id}: فشل التحقق الواقعي للقالب ${question.templateId || question.verification?.profile || 'غير معروف'}`);
    entries[question.id] = {
      status: 'verified',
      profile: question.verification.profile,
      questionSha256: questionDigest(question.category, question),
      claimSha256: claimDigest(question.category, question),
      evidence,
    };
  }
  return {
    schemaVersion: 2,
    contentSha256: contentDigest(categories),
    policySha256: hash(fs.readFileSync(POLICY_PATH)),
    verifierBundleSha256: verifierBundleDigest(verifierFiles),
    questionCount: questions.length,
    verifiedQuestionCount: Object.keys(entries).length,
    artifacts: Object.fromEntries([...artifactCache].sort(([left], [right]) => left.localeCompare(right))),
    questions: entries,
  };
}

export function approveVerifiedQuestions(categories, ledger, { verifierFiles = [] } = {}) {
  if (!Array.isArray(verifierFiles) || verifierFiles.length === 0) {
    throw new Error('لا يمكن اعتماد البنك بلا حزمة مدققات محددة صراحةً.');
  }
  const categoryQuestions = Object.entries(categories).flatMap(([category, questions]) =>
    questions.map(question => ({ category, question })));
  const ids = categoryQuestions.map(item => item.question.id);
  const currentPolicySha256 = hash(fs.readFileSync(POLICY_PATH));
  const artifactsMatch = Object.entries(ledger.artifacts || {}).every(([relativePath, expectedSha256]) => {
    try { return readArtifact(relativePath).sha256 === expectedSha256; } catch { return false; }
  });
  if (ledger.schemaVersion !== 2 || ledger.questionCount !== ids.length
      || ledger.verifiedQuestionCount !== ids.length
      || ledger.contentSha256 !== contentDigest(categories)
      || ledger.policySha256 !== currentPolicySha256
      || (verifierFiles.length && ledger.verifierBundleSha256 !== verifierBundleDigest(verifierFiles))
      || !artifactsMatch
      || ids.some(id => ledger.questions?.[id]?.status !== 'verified')
      || categoryQuestions.some(({ category, question }) =>
        ledger.questions?.[question.id]?.questionSha256 !== questionDigest(category, question)
        || ledger.questions?.[question.id]?.claimSha256 !== claimDigest(category, question)
        || !same(ledger.questions?.[question.id]?.evidence,
          expectedLedgerEvidence(question, ledger.artifacts)))
      || Object.keys(ledger.questions || {}).some(id => !ids.includes(id))) {
    throw new Error('سجل التحقق لا يطابق معرفات البنك.');
  }
  for (const questions of Object.values(categories)) for (const question of questions) {
    question.review = {
      ...question.review,
      status: 'approved',
      reviewer: question.review?.reviewer || 'Fatinah deterministic factual gate',
      reviewedAt: question.review?.reviewedAt || NEXT_RELEASE_REVIEW_DATE,
      basis: 'deterministic_source_claim_verified',
      humanReviewRequired: false,
      factualVerificationRequired: false,
      claimSha256: ledger.questions[question.id].claimSha256,
    };
  }
}
