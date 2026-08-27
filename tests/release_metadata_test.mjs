import assert from 'node:assert/strict';
import fs from 'node:fs';

const metadata = JSON.parse(fs.readFileSync(new URL('../release/current.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const project = fs.readFileSync(new URL('../ios/App/App.xcodeproj/project.pbxproj', import.meta.url), 'utf8');

assert.equal(metadata.schemaVersion, 1);
assert.equal(packageJson.version, metadata.packageVersion, 'package.json must match release/current.json');
assert.equal(metadata.bundleIdentifier, 'com.fatinah.game');
assert.match(metadata.releaseBranch, /^codex\/release-/);
assert.match(metadata.releaseTag, /^v\d+\.\d+\.\d+-build\.\d+$/);
assert.match(metadata.replitUrl, /^https:\/\/[a-z0-9-]+\.replit\.app$/);

const marketingMatches = [...project.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map(match => match[1]);
const buildMatches = [...project.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map(match => Number(match[1]));
assert.ok(marketingMatches.filter(value => value === metadata.iosMarketingVersion).length >= 2,
  'The app Debug and Release targets must match iosMarketingVersion');
assert.ok(buildMatches.filter(value => value === metadata.iosBuild).length >= 2,
  'The app Debug and Release targets must match iosBuild');

console.log(`✓ release metadata ${metadata.packageVersion} (${metadata.iosBuild}) is consistent`);
