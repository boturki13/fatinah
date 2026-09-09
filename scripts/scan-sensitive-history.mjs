import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(repositoryRoot, 'scripts', 'sensitive-history-baseline.json');
const scannerPath = 'scripts/scan-sensitive-history.mjs';
const baselineRepositoryPath = 'scripts/sensitive-history-baseline.json';
const strictHistory = process.argv.includes('--strict-history');
const maximumScannedFileBytes = 20 * 1024 * 1024;

function runGit(args, { allowNoMatch = false, encoding = 'utf8', input } = {}) {
  const result = spawnSync('git', args, {
    cwd: repositoryRoot,
    encoding,
    input,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !(allowNoMatch && result.status === 1)) {
    const detail = String(result.stderr || '').trim();
    throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout || '';
}

const baselineDocument = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
if (baselineDocument.schemaVersion !== 1 || !Array.isArray(baselineDocument.entries)) {
  throw new Error('Sensitive-history baseline has an unsupported schema.');
}

const acknowledgedObjects = new Set();
for (const entry of baselineDocument.entries) {
  if (!entry || !/^[a-f0-9]{40}$/.test(entry.objectId) || typeof entry.path !== 'string') {
    throw new Error('Sensitive-history baseline contains an invalid entry.');
  }
  const key = `${entry.objectId}:${entry.path}`;
  if (acknowledgedObjects.has(key)) {
    throw new Error(`Sensitive-history baseline contains a duplicate entry for ${entry.path}.`);
  }
  acknowledgedObjects.add(key);
}

const contentRules = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['openai-or-anthropic-key', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/],
  ['stripe-secret-key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b/],
  ['webhook-secret', /\bwhsec_[A-Za-z0-9]{12,}\b/],
  ['oauth-client-secret', /["']client_secret["']\s*:\s*["'][^"']{12,}["']/i],
  [
    'raw-authentication-diagnostic',
    /TO JS .{0,512}["']additionalUserInfo["'].{0,512}["'](?:sub|nonce)["']/s,
  ],
  [
    'raw-purchase-diagnostic',
    /TO JS .{0,512}["']customerInfo["'].{0,512}["'](?:originalAppUserId|subscriptionsByProductIdentifier|activeSubscriptions)["']/s,
  ],
];

function sensitivePathRule(filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  const baseName = normalized.split('/').at(-1) || '';
  if (/^\.env(?:\.|$)/i.test(baseName) && baseName !== '.env.example') return 'environment-file';
  if (/\.(?:p8|p12|pem|key|mobileprovision)$/i.test(baseName)) return 'credential-file';
  if (/(?:\.db(?:-(?:shm|wal|journal))?|\.sqlite3?)$/i.test(baseName)) return 'runtime-database';
  if (/service[-_]?account.*\.json$/i.test(baseName) || /firebase-adminsdk-.*\.json$/i.test(baseName)) {
    return 'service-account-file';
  }
  return null;
}

const findings = new Map();
function recordFinding(rule, filePath, objectId = 'WORKTREE') {
  const normalizedPath = filePath.replaceAll('\\', '/');
  if (objectId !== 'WORKTREE' && !strictHistory
      && acknowledgedObjects.has(`${objectId}:${normalizedPath}`)) return;
  const key = `${rule}:${objectId}:${normalizedPath}`;
  findings.set(key, { rule, filePath: normalizedPath, objectId });
}

// Check path-sensitive rules for every committable path. Content already
// reachable from HEAD is scanned below from Git objects, so only read new or
// modified worktree/index files again. This keeps pre-commit and CI scans fast
// without reducing history coverage.
const committableFiles = String(runGit([
  'ls-files', '-z', '--cached', '--others', '--exclude-standard',
], { encoding: null })).split('\0').filter(Boolean);
for (const relativePath of committableFiles) {
  const pathRule = sensitivePathRule(relativePath);
  if (pathRule) recordFinding(pathRule, relativePath);
}
const changedFiles = new Set([
  ...String(runGit([
    'ls-files', '-z', '--modified', '--others', '--exclude-standard',
  ], { encoding: null })).split('\0').filter(Boolean),
  ...String(runGit([
    'diff', '--cached', '--name-only', '--diff-filter=ACM', '-z',
  ], { encoding: null })).split('\0').filter(Boolean),
]);
for (const relativePath of changedFiles) {
  const absolutePath = path.join(repositoryRoot, relativePath);
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    continue; // A tracked file deleted in the working tree is intentionally absent.
  }
  if (!stat.isFile()) continue;
  if (stat.size > maximumScannedFileBytes
      || relativePath === scannerPath || relativePath === baselineRepositoryPath) continue;
  const contents = fs.readFileSync(absolutePath).toString('utf8');
  for (const [rule, expression] of contentRules) {
    if (expression.test(contents)) recordFinding(rule, relativePath);
  }
}

const shallow = String(runGit(['rev-parse', '--is-shallow-repository'])).trim() === 'true';
if (shallow) recordFinding('incomplete-history', '(repository checkout)');

const reachableObjects = new Set();
const objectPaths = new Map();
const objectRows = String(runGit(['rev-list', '--objects', '--all'])).split('\n').filter(Boolean);
for (const row of objectRows) {
  const separator = row.indexOf(' ');
  const objectId = separator < 0 ? row : row.slice(0, separator);
  reachableObjects.add(objectId);
}

// `rev-list --objects` names a reused object only once. Derive every historical
// blob/path pair from the raw commit changes so copying an acknowledged blob to
// a different path cannot inherit the old path's acknowledgement.
const historicalChanges = String(runGit([
  'log', '--all', '--root', '--raw', '--no-abbrev', '--no-renames',
  '--format=', '-z', '--diff-filter=ACMT',
], { encoding: null })).split('\0').filter(Boolean);
for (let index = 0; index < historicalChanges.length;) {
  const header = historicalChanges[index].replace(/^\n+/, '');
  const relativePath = historicalChanges[index + 1];
  index += 2;
  const fields = header.split(/\s+/);
  const objectId = fields[3];
  if (!header.startsWith(':') || !relativePath || !/^[a-f0-9]{40}$/.test(objectId)) {
    throw new Error('Unexpected raw Git history record.');
  }
  const paths = objectPaths.get(objectId) || new Set();
  paths.add(relativePath);
  objectPaths.set(objectId, paths);
  const rule = sensitivePathRule(relativePath);
  if (rule) recordFinding(rule, relativePath, objectId);
}

// Read each reachable historical blob once. Batching avoids the quadratic cost
// of grepping every commit tree separately while preserving full-history coverage.
const objectIds = [...objectPaths.keys()];
const objectMetadata = String(runGit(
  ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
  { input: `${objectIds.join('\n')}\n` },
)).split('\n').filter(Boolean);
const historicalBlobs = [];
for (const row of objectMetadata) {
  const [objectId, objectType, rawSize] = row.split(' ');
  const size = Number(rawSize);
  if (objectType === 'blob' && Number.isSafeInteger(size)
      && size >= 0 && size <= maximumScannedFileBytes) {
    historicalBlobs.push({ objectId, size });
  }
}

const maximumBatchBytes = 16 * 1024 * 1024;
const batches = [];
let batch = [];
let batchBytes = 0;
for (const blob of historicalBlobs) {
  if (batch.length > 0 && batchBytes + blob.size > maximumBatchBytes) {
    batches.push(batch);
    batch = [];
    batchBytes = 0;
  }
  batch.push(blob);
  batchBytes += blob.size;
}
if (batch.length > 0) batches.push(batch);

for (const blobs of batches) {
  const output = runGit(['cat-file', '--batch'], {
    encoding: null,
    input: `${blobs.map(blob => blob.objectId).join('\n')}\n`,
  });
  let offset = 0;
  while (offset < output.length) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error('Unexpected git cat-file batch output.');
    const header = output.subarray(offset, headerEnd).toString('utf8');
    const [objectId, objectType, rawSize] = header.split(' ');
    const size = Number(rawSize);
    if (objectType !== 'blob' || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Unexpected git object metadata for ${objectId}.`);
    }
    const contentsStart = headerEnd + 1;
    const contentsEnd = contentsStart + size;
    if (contentsEnd > output.length) throw new Error(`Truncated Git blob ${objectId}.`);
    const contents = output.subarray(contentsStart, contentsEnd).toString('utf8');
    offset = contentsEnd + 1;

    for (const relativePath of objectPaths.get(objectId) || []) {
      if (relativePath === scannerPath || relativePath === baselineRepositoryPath) continue;
      for (const [rule, expression] of contentRules) {
        if (expression.test(contents)) recordFinding(rule, relativePath, objectId);
      }
    }
  }
}

if (findings.size > 0) {
  console.error(`Sensitive repository scan failed with ${findings.size} finding(s).`);
  for (const finding of [...findings.values()].sort((left, right) =>
    left.filePath.localeCompare(right.filePath) || left.rule.localeCompare(right.rule))) {
    const location = finding.objectId === 'WORKTREE'
      ? 'working tree'
      : `Git object ${finding.objectId.slice(0, 12)}`;
    console.error(`- ${finding.rule}: ${finding.filePath} (${location})`);
  }
  console.error('Matched values are intentionally not printed. Remove the file or acknowledge only an exact historical blob after incident review.');
  process.exitCode = 1;
} else {
  const reachableAcknowledgements = baselineDocument.entries.filter(entry =>
    reachableObjects.has(entry.objectId)).length;
  console.log(`Sensitive repository scan passed; ${reachableAcknowledgements} exact historical object(s) remain acknowledged pending an authorized history rewrite.`);
}
