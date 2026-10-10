import { chromium, expect } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';

const origin = 'http://127.0.0.1:4310';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.route('**/*', route => {
    const request = route.request();
    return new URL(request.url()).origin === origin && request.method() === 'GET' ? route.continue() : route.abort();
  });
  await page.goto(origin);
  await expect(page.locator('.radar-group').first()).toBeVisible();
  expect(await page.locator('.sidebar').evaluate(element => element.getBoundingClientRect().width)).toBe(184);
  mkdirSync('artifacts', { recursive: true });
  const snapshot = async (name: string) => {
    const titles = await page.locator('.radar-story h3 button, .hot-title, .edition-project h3 button, .content-card h3 button').allTextContents();
    for (const title of titles) expect(title).toMatch(/\p{Script=Han}/u);
    if (page.viewportSize()!.width < 700) {
      await expect(page.getByRole('button', { name: '打开导航', exact: true })).toBeVisible();
      await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
    }
    await page.screenshot({ path: `artifacts/editorial-${name}.png`, fullPage: true, animations: 'disabled' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    console.log(`${name}: no horizontal overflow`);
  };
  await snapshot('home-desktop');
  await page.getByRole('button', { name: '热点榜', exact: true }).click();
  await expect(page.locator('.ranked-module').first()).toBeVisible();
  await snapshot('hotlist-desktop');
  await page.getByRole('group', { name: '内容模块' }).getByRole('button', { name: 'Skills', exact: true }).click();
  await page.getByLabel('Skill 排序', { exact: true }).selectOption('stars');
  await expect(page.locator('.ranked-module')).toHaveCount(1);
  await expect(page.locator('.ranked-module')).toContainText('来源仓库 Star');
  await snapshot('skills-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await snapshot('skills-mobile');
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.getByRole('button', { name: '精选历史', exact: true }).click();
  await expect(page.locator('.edition-project').first()).toBeVisible();
  await snapshot('history-desktop');
  for (const width of [1600, 1340, 1100, 820, 700, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator('main')).toHaveClass(/history-main/);
    await expect.poll(() => page.locator('.edition-layout').evaluate(element => Math.round(element.getBoundingClientRect().left))).toBe(width <= 700 ? 0 : width <= 920 ? 168 : 184);
    const metrics = await page.locator('.edition-paper').evaluate(element => {
      const body = element.querySelector('.edition-body')!;
      const stories = element.querySelector('.edition-stories')!;
      const column = stories.getBoundingClientRect();
      const headings = [...element.querySelectorAll('.edition-project h3 button')];
      return { width: element.clientWidth, overflow: element.scrollWidth > element.clientWidth + 1, bodyOverflow: body.scrollWidth > body.clientWidth + 1, titleOverflow: headings.some(heading => heading.getBoundingClientRect().right > column.right + 1 || heading.scrollWidth > heading.clientWidth + 1) };
    });
    expect(metrics.overflow).toBe(false);
    expect(metrics.bodyOverflow).toBe(false);
    expect(metrics.titleOverflow).toBe(false);
    await page.screenshot({ path: `artifacts/history-fit-${width}.png`, fullPage: false, animations: 'disabled' });
    console.log(`history ${width}px: container and titles fit`);
  }
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.getByRole('button', { name: '今日精选', exact: true }).click();
  await expect(page.locator('.radar-group').first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await snapshot('home-mobile');
  expect(failures).toEqual([]);
  console.log('Read-only visual verification passed; no mutations or external requests allowed.');
} finally { await browser.close(); }
