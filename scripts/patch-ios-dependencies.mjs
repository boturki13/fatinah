import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const bridgePath = resolve('node_modules/@capacitor/ios/Capacitor/Capacitor/CapacitorBridge.swift');
let bridge = await readFile(bridgePath, 'utf8');

const replacements = [
  [
    `self.eval(js: "window.Capacitor.triggerEvent('\\(eventName)', '\\(target)')")`,
    `self.eval(js: "if (window.Capacitor && typeof window.Capacitor.triggerEvent === 'function') { window.Capacitor.triggerEvent('\\(eventName)', '\\(target)') }")`,
  ],
  [
    `self.eval(js: "window.Capacitor.triggerEvent('\\(eventName)', '\\(target)', \\(data))")`,
    `self.eval(js: "if (window.Capacitor && typeof window.Capacitor.triggerEvent === 'function') { window.Capacitor.triggerEvent('\\(eventName)', '\\(target)', \\(data)) }")`,
  ],
];

let changed = false;
for (const [before, after] of replacements) {
  if (bridge.includes(after)) continue;
  if (!bridge.includes(before)) {
    throw new Error(`CapacitorBridge.swift changed upstream; missing expected triggerJSEvent source: ${before}`);
  }
  bridge = bridge.replace(before, after);
  changed = true;
}

if (changed) await writeFile(bridgePath, bridge);
console.log(changed ? 'Patched Capacitor early JS events.' : 'Capacitor early JS events already patched.');
