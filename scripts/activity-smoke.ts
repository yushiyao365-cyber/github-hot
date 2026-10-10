import { chromium, expect } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { Store } from '../server/store.js';
import { radarFixture } from '../tests/radar-fixtures.js';
import { fixtureRepo } from '../tests/fixtures.js';

const store = new Store(':memory:');
const services = radarFixture(store, 4316);
for (let index = 10; index < 40; index++) store.upsertRepo(fixtureRepo(index, { description: 'Apache Paimon 中文测试资料，仅用于布局回归', firstSeenAt: new Date(Date.UTC(2026, 9, 8, 0, index)).toISOString() }));
await services.app.listen({ port: 4316, host: '127.0.0.1' });
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:4316' ? route.continue() : route.abort());
  await page.goto('http://127.0.0.1:4316');
  const navigation = page.getByRole('navigation', { name: '主导航' });
  await expect(navigation.getByRole('button')).toHaveText(['今日精选', '热点榜', '精选历史', '我的清单']);
  await expect(page.locator('.radar-group').first()).toBeVisible();
  await expect(page.locator('.activity-page')).toHaveCount(0);
  mkdirSync('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/activity-removed-desktop-test.png', animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/activity-removed-mobile-test.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await expect(navigation.getByRole('button', { name: '全部动态', exact: true })).toHaveCount(0);
  await expect(navigation.getByRole('button')).toHaveCount(4);
  expect(errors).toEqual([]); expect(services.calls()).toBe(0);
  console.log('Removed activity entry: desktop and mobile retain four navigation items; candidate data preserved.');
} finally { await browser.close(); await services.app.close(); store.close(); }
