#!/usr/bin/env node
import {
  MANIFEST_PATH,
  buildRuntimeAuditManifest,
  writeManifestAtomic,
} from './runtime-audit-manifest-lib.mjs';

const manifest = buildRuntimeAuditManifest();
writeManifestAtomic(manifest);
console.log(JSON.stringify({
  manifest: MANIFEST_PATH,
  fingerprint: manifest.runtimeFingerprintSha256,
  components: manifest.components,
  counts: manifest.counts,
}, null, 2));
