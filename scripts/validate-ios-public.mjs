import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const webDirectory = path.join(root, 'www');
const iosPublicDirectory = path.join(root, 'ios', 'App', 'App', 'public');
const duplicateSuffix = / [0-9]+\.[^/]+$/;

async function filesBelow(directory, relative = '') {
  const entries = await readdir(path.join(directory, relative), {
    withFileTypes: true,
  });
  const files = [];

  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...await filesBelow(directory, child));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }

  return files;
}

const iosFiles = await filesBelow(iosPublicDirectory);
const duplicateFiles = iosFiles.filter(file => duplicateSuffix.test(file));

if (duplicateFiles.length > 0) {
  throw new Error(
    `Duplicate-suffixed files found in the iOS web bundle:\n${duplicateFiles.join('\n')}`,
  );
}

const webFiles = await filesBelow(webDirectory);
const mismatches = [];

for (const file of webFiles) {
  try {
    const [webContents, iosContents] = await Promise.all([
      readFile(path.join(webDirectory, file)),
      readFile(path.join(iosPublicDirectory, file)),
    ]);
    if (!webContents.equals(iosContents)) mismatches.push(file);
  } catch {
    mismatches.push(file);
  }
}

if (mismatches.length > 0) {
  throw new Error(
    `The iOS web bundle is not synchronized with www/:\n${mismatches.join('\n')}`,
  );
}

console.log(`iOS web bundle validated: ${webFiles.length} source files synchronized.`);
