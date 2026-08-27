import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../scripts/load-test.mjs', import.meta.url), 'utf8');
assert.match(source, /FATINAH_LOAD_TEST_URL/);
assert.match(source, /FATINAH_LOAD_TEST_APPROVED/);
assert.match(source, /errorRate > 0\.05/);
assert.match(source, /p95Ms > 3000/);
assert.doesNotMatch(source, /https:\/\/(?:www\.)?ata20\.com/i);

const result = spawnSync(process.execPath, ['scripts/load-test.mjs', '--plan'], {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
const plan = JSON.parse(result.stdout);
assert.deepEqual(plan.stages.map(stage => stage.users), [100, 300, 500, 1000]);
assert.deepEqual(plan.stages.map(stage => stage.durationSeconds), [300, 300, 600, 600]);

const refused = spawnSync(process.execPath, ['scripts/load-test.mjs'], {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8',
  env: { ...process.env, FATINAH_LOAD_TEST_URL: '', FATINAH_LOAD_TEST_APPROVED: '' },
});
assert.notEqual(refused.status, 0);

console.log('✓ اختبار الضغط متدرج، يتوقف بأمان، ويرفض أي هدف غير معتمد');
