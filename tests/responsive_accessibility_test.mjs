import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = `file://${path.join(root, 'www/index.html')}`;
const sizes = [
  ['iPhone portrait', 390, 844], ['iPhone landscape', 844, 390],
  ['iPad portrait', 820, 1180], ['iPad landscape', 1180, 820],
];
const browser = await chromium.launch();
try {
  for (const [name, width, height] of sizes) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(url);
    await page.evaluate(() => window.go('s-auth'));
    const audit = await page.evaluate(() => {
      const visible = element => {
        const style = getComputedStyle(element), rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const undersized = [...document.querySelectorAll('button,a[href],input,select,textarea,[role="button"],[role="radio"]')]
        .filter(visible).map(element => {
          const rect = element.getBoundingClientRect();
          return { label: element.getAttribute('aria-label') || element.textContent.trim() || element.id,
                   width: Math.round(rect.width), height: Math.round(rect.height) };
        }).filter(item => item.width < 44 || item.height < 44);
      return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, undersized };
    });
    assert.ok(audit.overflow <= 1, `${name}: horizontal overflow ${audit.overflow}px`);
    assert.deepEqual(audit.undersized, [], `${name}: touch targets under 44×44`);
    await page.close();
    console.log(`✓ ${name}: بلا تجاوز أفقي وكل مناطق اللمس 44×44 على الأقل`);
  }
} finally {
  await browser.close();
}
