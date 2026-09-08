import { rm } from 'node:fs/promises';
import path from 'node:path';
import { excludedQuestionDataFiles } from './ios-public-contract.mjs';

const root = process.cwd();
const iosPublicDirectory = path.join(root, 'ios', 'App', 'App', 'public');

await Promise.all(excludedQuestionDataFiles.map(file => (
  rm(path.join(iosPublicDirectory, file), { force: true })
)));

console.log(`iOS bundle pruned: ${excludedQuestionDataFiles.length} embedded question-data files excluded.`);
