import { expect, test } from "@playwright/test";
import type { Span } from "../src/lib/api";
import { analyzeTiming } from "../src/features/runs/_components/views/timeline-analysis";
import { open, state } from "./util";
const span = (id: string, start: number, end: number, parent: string | null = null, kind = "TOOL"): Span => ({ span_id: id, parent_span_id: parent, name: id, span_kind: kind, start_ms: start, end_ms: end, duration_ms: end - start, status_code: 0, model: null, tool_name: null, total_tokens: null, input_preview: null, output_preview: null, error: null, tool_result: null });

test("merges overlapping direct children, clips boundaries and ignores grandchildren", () => {
  const result = analyzeTiming([span('root', 0, 100, null, 'WORKFLOW'), span('a', -10, 40, 'root'), span('b', 20, 60, 'root'), span('c', 80, 120, 'root'), span('nested', 25, 35, 'b')]);
  expect(result.rows[0].outside).toBe(20);
  expect(result.rows[0].inconsistent).toBe(true);
  expect(result.rows[2].outside).toBe(30);
});
test("gaps exclude enclosing spans; zero, missing and malformed evidence is explicit", () => {
  const result = analyzeTiming([span('root', 0, 100, null, 'WORKFLOW'), span('a', 10, 20, 'root'), span('b', 40, 50, 'root'), span('zero', 50, 50, 'root'), { ...span('live', 60, 70, 'root'), end_ns: '0' }, span('bad', NaN, 80, 'root'), span('reverse', 90, 80, 'root'), span('infinite', 0, Infinity, 'root'), span('overflow', -Number.MAX_VALUE, Number.MAX_VALUE, 'root')]);
  expect(result.gaps).toEqual([{ start: 20, end: 40 }]);
  expect(analyzeTiming([span('a', 0, 10), span('b', 20, 30), span('c', 40, 50)]).gaps).toEqual([{ start: 10, end: 20 }, { start: 30, end: 40 }]);
  expect(result.rows[0].outside).toBeNull();
  expect(result.rows[3].outside).toBe(0);
  expect(result.rows.slice(4).every((row) => row.duration === null)).toBe(true);
  expect(result.rows.every((row) => row.outside === null || (Number.isFinite(row.outside) && row.outside >= 0))).toBe(true);
});
for (const theme of ['light', 'dark', 'mobile'] as const) {
  test(`timing sorting, navigation and zoom (${theme})`, async ({ page }, testInfo) => {
    await open(page, `runs/${state().supportRun}?view=timeline`);
    if (theme === 'mobile') await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
    await page.getByTestId('run-views').getByRole('tab', { name: 'Timeline' }).click();
    const breakdown = page.getByTestId('timing-breakdown');
    await breakdown.locator('summary').click();
    await expect(breakdown.getByText('Gaps in recorded activity', { exact: true })).toBeVisible();
    await breakdown.getByRole('button', { name: /Outside direct children/ }).click();
    await expect(breakdown.locator('th[aria-sort="descending"]')).toContainText('Outside direct children');
    await breakdown.getByRole('button', { name: /Outside direct children/ }).click();
    await expect(breakdown.locator('th[aria-sort="ascending"]')).toContainText('Outside direct children');
    await page.locator('#tl-zoom').fill('2');
    await expect(page.locator('#tl-zoom')).toHaveValue('2');
    await page.screenshot({ path: testInfo.outputPath(`timing-${theme}.png`), fullPage: true });
    await breakdown.getByRole('button', { name: 'lookup_order', exact: true }).click();
    await expect(page.getByRole('dialog').getByText('lookup_order').first()).toBeVisible();
  });
}
