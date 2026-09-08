import assert from 'node:assert/strict';
import fs from 'node:fs';

const metadata = JSON.parse(fs.readFileSync(new URL('../release/current.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const project = fs.readFileSync(new URL('../ios/App/App.xcodeproj/project.pbxproj', import.meta.url), 'utf8');
const scheme = fs.readFileSync(new URL('../ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme', import.meta.url), 'utf8');
const podfile = fs.readFileSync(new URL('../ios/App/Podfile', import.meta.url), 'utf8');
const iosGitignore = fs.readFileSync(new URL('../ios/.gitignore', import.meta.url), 'utf8');
const iosReleaseWorkflow = fs.readFileSync(new URL('../.github/workflows/ios-release-gate.yml', import.meta.url), 'utf8');
const coreWorkflow = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

assert.equal(metadata.schemaVersion, 1);
assert.equal(packageJson.version, metadata.packageVersion, 'package.json must match release/current.json');
assert.match(packageJson.scripts['questions:next-release-gate'],/--release\b/,
  'The next-bank release command must enforce factual release readiness');
assert.doesNotMatch(packageJson.scripts['questions:next-release-audit'],/--release\b/,
  'The structural QA command must remain available without claiming release readiness');
assert.equal(metadata.bundleIdentifier, 'com.fatinah.game');
assert.match(metadata.releaseBranch, /^codex\/release-/);
assert.match(metadata.releaseTag, /^v\d+\.\d+\.\d+-build\.\d+$/);
assert.match(metadata.productionApiUrl, /^https:\/\/[a-z0-9.-]+$/);
assert.ok(metadata.replitUrl === null || /^https:\/\/[a-z0-9-]+\.replit\.app$/.test(metadata.replitUrl));
if (metadata.serverDeploymentState === 'pending') {
  assert.equal(metadata.replitEnvironment, 'staging');
  assert.equal(metadata.replitUrl, null, 'لا يجوز توثيق رابط staging غير متحقق منه.');
}

const marketingMatches = [...project.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map(match => match[1]);
const buildMatches = [...project.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map(match => Number(match[1]));
assert.ok(marketingMatches.filter(value => value === metadata.iosMarketingVersion).length >= 2,
  'The app Debug and Release targets must match iosMarketingVersion');
assert.ok(buildMatches.filter(value => value === metadata.iosBuild).length >= 2,
  'The app Debug and Release targets must match iosBuild');

const appConfigurations = [...project.matchAll(/^\t\t[A-F0-9]+ \/\* (Debug|Release) \*\/ = \{([\s\S]*?)^\t\t\};$/gm)]
  .filter(([, , body]) => body.includes('PRODUCT_BUNDLE_IDENTIFIER = com.fatinah.game;'));
const appDebugConfiguration = appConfigurations.find(([, name]) => name === 'Debug')?.[2];
const appReleaseConfiguration = appConfigurations.find(([, name]) => name === 'Release')?.[2];
assert.ok(appDebugConfiguration, 'The app Debug build configuration must exist');
assert.ok(appReleaseConfiguration, 'The app Release build configuration must exist');
assert.match(appDebugConfiguration, /ENABLE_CODE_COVERAGE = YES;/,
  'Debug Swift Testing and XCUITest builds must keep code coverage enabled');
assert.match(appReleaseConfiguration, /ENABLE_CODE_COVERAGE = NO;/,
  'Production build and archive configurations must disable code coverage instrumentation');
assert.match(scheme, /<TestAction[\s\S]*?buildConfiguration = "Debug"/,
  'The test action must use the coverage-enabled Debug configuration');
assert.match(scheme, /<ArchiveAction[\s\S]*?buildConfiguration = "Release"/,
  'The archive action must use the coverage-disabled Release configuration');
assert.match(podfile, /if config\.name == 'Release'[\s\S]*?ENABLE_CODE_COVERAGE'\] = 'NO'/,
  'Release pod dependencies must disable coverage so production archives contain no LLVM instrumentation');

const fetchAssetsIndex = iosReleaseWorkflow.indexOf('npm run images:fetch-release-assets');
const npmTestIndex = iosReleaseWorkflow.indexOf('npm test');
const installChromiumIndex = iosReleaseWorkflow.indexOf('npx playwright install chromium');
const contentGateIndex = iosReleaseWorkflow.indexOf('npm run questions:next-release-gate');
const runtimeReleaseGateIndex = iosReleaseWorkflow.indexOf('npm run questions:release-gate');
const contentDriftIndex = iosReleaseWorkflow.indexOf('git diff --exit-code --');
const trackedArtifactIndex = iosReleaseWorkflow.indexOf('git ls-files --error-unmatch "$artifact"');
const syncIosIndex = iosReleaseWorkflow.indexOf('npm run sync:ios');
const refreshedIosCopyIndex = iosReleaseWorkflow.indexOf('npx cap copy ios', contentGateIndex);
const refreshedIosValidationIndex = iosReleaseWorkflow.indexOf(
  'node scripts/validate-ios-public.mjs', refreshedIosCopyIndex);
const refreshedIosPruneIndex = iosReleaseWorkflow.indexOf(
  'node scripts/prune-ios-public.mjs', refreshedIosCopyIndex);
assert.match(iosReleaseWorkflow, /push:\s*[\s\S]*?tags:\s*\['v\*'\]/,
  'The iOS release gate must run for release tags');
assert.match(iosReleaseWorkflow, /workflow_dispatch:/,
  'The iOS release gate must support a deliberate manual run');
assert.match(iosReleaseWorkflow, /permissions:\s*\n\s+contents:\s*read/,
  'The iOS release gate must use least-privilege read-only repository permissions');
assert.ok(fetchAssetsIndex >= 0, 'The iOS release gate must fetch and verify production image assets');
assert.ok(npmTestIndex >= 0, 'The iOS release gate must run npm test');
assert.ok(installChromiumIndex >= 0 && installChromiumIndex < npmTestIndex,
  'The iOS release gate must install Chromium before Playwright tests');
assert.ok(contentGateIndex >= 0, 'The iOS release gate must validate the next question bank');
assert.ok(runtimeReleaseGateIndex >= 0 && runtimeReleaseGateIndex < contentGateIndex,
  'The iOS release gate must block on the published runtime question bank before validating the next bank');
assert.ok(trackedArtifactIndex > contentGateIndex && trackedArtifactIndex < contentDriftIndex,
  'The iOS release gate must reject generated artifacts that were omitted from the commit');
assert.ok(contentDriftIndex > contentGateIndex,
  'The iOS release gate must reject generated question-bank drift');
assert.ok(syncIosIndex >= 0 && syncIosIndex < runtimeReleaseGateIndex,
  'A clean checkout must generate the ignored iOS public bundle before a content gate can read it');
assert.ok(runtimeReleaseGateIndex < contentGateIndex && contentGateIndex < refreshedIosCopyIndex &&
  refreshedIosCopyIndex < refreshedIosPruneIndex && refreshedIosPruneIndex < refreshedIosValidationIndex &&
  refreshedIosValidationIndex < npmTestIndex,
  'After generation, CI must recopy and validate the iOS web bundle before running tests');
assert.ok(fetchAssetsIndex < npmTestIndex,
  'The iOS release gate must fetch production image assets before npm test on a clean checkout');

const coreInstallIndex = coreWorkflow.indexOf('npm ci');
const sensitiveHistoryScanIndex = coreWorkflow.indexOf('npm run security:scan-history');
const coreQuestionGateIndex = coreWorkflow.indexOf('npm run questions:next-release-gate');
const coreImageGateIndex = coreWorkflow.indexOf('npm run images:build-curated-300');
const coreSyncIosIndex = coreWorkflow.indexOf('npm run sync:ios');
const coreRefreshedIosCopyIndex = coreWorkflow.indexOf('npx cap copy ios', coreImageGateIndex);
const coreRefreshedIosValidationIndex = coreWorkflow.indexOf(
  'node scripts/validate-ios-public.mjs', coreRefreshedIosCopyIndex);
const coreRefreshedIosPruneIndex = coreWorkflow.indexOf(
  'node scripts/prune-ios-public.mjs', coreRefreshedIosCopyIndex);
const coreStaticTestsIndex = coreWorkflow.indexOf('npm run test:static');
const coreContentTestsIndex = coreWorkflow.indexOf('npm run test:web:content');
assert.match(coreWorkflow, /name: Checkout\s*[\s\S]*?fetch-depth:\s*0/,
  'The core CI checkout must include full Git history for the sensitive-material scan');
assert.ok(sensitiveHistoryScanIndex >= 0 && sensitiveHistoryScanIndex < coreInstallIndex,
  'Core CI must scan the repository and complete Git history before installing dependencies');
assert.ok(coreQuestionGateIndex > coreInstallIndex && coreQuestionGateIndex < coreContentTestsIndex,
  'Core CI must regenerate and release-gate the next question bank before content tests');
assert.ok(coreSyncIosIndex > coreInstallIndex && coreSyncIosIndex < coreQuestionGateIndex,
  'Core CI must create the ignored iOS public bundle before clean-checkout content gates');
assert.ok(coreImageGateIndex < coreRefreshedIosCopyIndex &&
  coreRefreshedIosCopyIndex < coreRefreshedIosPruneIndex &&
  coreRefreshedIosPruneIndex < coreRefreshedIosValidationIndex &&
  coreRefreshedIosValidationIndex < coreStaticTestsIndex,
  'Core CI must refresh and validate the final generated native web bundle before static tests');
for (const workflow of [coreWorkflow, iosReleaseWorkflow]) {
  assert.match(workflow, /content\/questions\/next-release-factual-ledger\.json/,
    'Question-bank drift checks must include the factual verification ledger');
}

assert.match(iosGitignore, /^App\/App\/public\s*$/m,
  'The test must model clean checkout correctly: the native public bundle is generated and ignored');
for (const [name, workflow] of [['CI', coreWorkflow], ['iOS release gate', iosReleaseWorkflow]]) {
  const trackingCommand = workflow.indexOf('git ls-files --error-unmatch "$artifact"');
  const artifactListStart = workflow.lastIndexOf('generated_artifacts=(', trackingCommand);
  const artifactListEnd = workflow.indexOf('\n          )', artifactListStart);
  const trackedSources = workflow.slice(artifactListStart, artifactListEnd);
  assert.match(trackedSources, /server-assets\/question-images\/curated-question-bank\.json/,
    `${name} must still require the generated server bank to be tracked`);
  assert.match(trackedSources, /www\/curated-image-options\.js/,
    `${name} must still require the generated www source to be tracked`);
  assert.doesNotMatch(trackedSources, /ios\/App\/App\/public/,
    `${name} must not require ignored native output files to be tracked`);
}

const xcodeTestIndex = iosReleaseWorkflow.indexOf('xcodebuild test');
const releaseArchiveIndex = iosReleaseWorkflow.indexOf('xcodebuild archive');
assert.ok(xcodeTestIndex >= 0 && releaseArchiveIndex > xcodeTestIndex,
  'The iOS release gate must test before archiving the production configuration');
const xcodeTestCommand = iosReleaseWorkflow.slice(xcodeTestIndex, releaseArchiveIndex);
assert.match(xcodeTestCommand, /-enableCodeCoverage YES/,
  'Swift Testing and XCUITest must collect Debug code coverage');
assert.doesNotMatch(xcodeTestCommand, /ENABLE_CODE_COVERAGE=NO/,
  'The Debug test command must not disable code coverage');
const nextStepIndex = iosReleaseWorkflow.indexOf('\n      - name:', releaseArchiveIndex);
const releaseArchiveCommand = iosReleaseWorkflow.slice(
  releaseArchiveIndex,
  nextStepIndex >= 0 ? nextStepIndex : iosReleaseWorkflow.length,
);
assert.match(releaseArchiveCommand, /-configuration Release/,
  'The production archive must use the Release configuration');
assert.match(releaseArchiveCommand, /-archivePath/,
  'The production archive must use an explicit archive output path');
assert.match(releaseArchiveCommand, /ENABLE_CODE_COVERAGE=NO/,
  'The production CI archive must explicitly disable code coverage instrumentation');
assert.match(releaseArchiveCommand, /find .*Products\/Applications[\s\S]*?-name '\*\.app'/,
  'The release gate must verify that the archive contains an app bundle');

for (const [name, workflow] of [['CI', coreWorkflow], ['iOS release gate', iosReleaseWorkflow]]) {
  assert.doesNotMatch(
    workflow,
    /uses:\s*(?:actions\/|astral-sh\/)[^\s@]+@v\d+/,
    `${name} must pin third-party actions to immutable commit SHAs`,
  );
  for (const match of workflow.matchAll(/uses:\s*(?:actions\/|astral-sh\/)[^\s@]+@([^\s#]+)/g)) {
    assert.match(match[1], /^[a-f0-9]{40}$/i, `${name} action is not pinned to a full commit SHA`);
  }
}

console.log(`✓ release metadata ${metadata.packageVersion} (${metadata.iosBuild}) is consistent`);
