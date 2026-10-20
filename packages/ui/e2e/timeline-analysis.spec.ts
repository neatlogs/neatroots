import { expect, test } from "@playwright/test";
import { randomBytes } from "node:crypto";
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
test("raw reversed timestamps remain unavailable after store normalization", () => {
  const reversed = { ...span('reversed', 90, 90, 'root'), start_ns: '90000000', end_ns: '80000000' };
  const result = analyzeTiming([span('root', 0, 100, null, 'WORKFLOW'), span('a', 10, 20, 'root'), reversed, span('b', 95, 100, 'root')]);
  expect(result.rows[2].interval).toBeNull();
  expect(result.rows[2].duration).toBeNull();
  expect(result.rows[2].outside).toBeNull();
  expect(result.rows[0].outside).toBeNull();
  expect(result.gaps).toEqual([{ start: 20, end: 95 }]);
  expect(result.incomplete).toBe(true);
});

test("raw timestamps preserve precision, genuine zero durations and missing-field compatibility", () => {
  const zero = span('zero', 1_700_000_000_090, 1_700_000_000_090);
  const start = '1700000000090000001';
  expect(analyzeTiming([{ ...zero, start_ns: start, end_ns: start }]).rows[0].duration).toBe(0);
  expect(analyzeTiming([{ ...zero, start_ns: start, end_ns: '1700000000090000000' }]).rows[0].duration).toBeNull();
  expect(analyzeTiming([{ ...zero, start_ns: start, end_ns: '0' }]).rows[0].duration).toBeNull();
  expect(analyzeTiming([{ ...zero, start_ns: start, end_ns: '000' }]).rows[0].duration).toBeNull();
  expect(analyzeTiming([zero]).rows[0].duration).toBe(0);
  expect(analyzeTiming([{ ...zero, start_ns: start }]).rows[0].duration).toBe(0);
  expect(analyzeTiming([{ ...zero, end_ns: start }]).rows[0].duration).toBe(0);
  for (const invalid of ['', '-1', '1.5', '1e9', ' 90 ', '90\n', 'garbage', '18446744073709551616', '9'.repeat(1000), 90, null]) {
    for (const key of ['start_ns', 'end_ns']) {
      const candidate = { ...zero, start_ns: start, end_ns: start, [key]: invalid } as Span;
      expect(analyzeTiming([candidate]).rows[0].duration, `${key}: ${String(invalid)}`).toBeNull();
    }
  }
});

test("raw reversed timestamps survive the collector and show unavailable evidence", async ({ page, request }, testInfo) => {
  const traceId = randomBytes(16).toString('hex');
  const rootId = '0000000000000001';
  const base = 1_700_000_000_000_000_000n;
  const makeSpan = (id: string, name: string, start: number, end: number, root = false) => ({
    traceId, spanId: id, parentSpanId: root ? '' : rootId, name, kind: 1,
    startTimeUnixNano: String(base + BigInt(start) * 1_000_000n),
    endTimeUnixNano: String(base + BigInt(end) * 1_000_000n),
    attributes: [{ key: 'neatlogs.span.kind', value: { stringValue: root ? 'workflow' : 'tool' } }],
    status: { code: 1 },
  });
  const response = await request.post(`${state().url}/v1/traces`, { data: {
    resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'e2e-raw-timing' } }] }, scopeSpans: [{ spans: [
      makeSpan(rootId, 'raw-timing-root', 0, 100, true),
      makeSpan('0000000000000002', 'first-call', 10, 20),
      makeSpan('0000000000000003', 'reversed-call', 90, 80),
      makeSpan('0000000000000004', 'last-call', 95, 100),
      makeSpan('0000000000000005', 'zero-call', 20, 20),
    ] }] }],
  } });
  expect(response.ok()).toBe(true);
  const detailResponse = await request.get(`${state().url}/api/runs/${traceId}`);
  expect(detailResponse.ok()).toBe(true);
  const detail = await detailResponse.json() as { spans: Span[] };
  const reversed = detail.spans.find((item) => item.name === 'reversed-call')!;
  expect(reversed.start_ns).toBe(String(base + 90_000_000n));
  expect(reversed.end_ns).toBe(String(base + 80_000_000n));
  expect(reversed.end_ms).toBe(reversed.start_ms);
  expect(reversed.duration_ms).toBe(0);
  const analysis = analyzeTiming(detail.spans);
  expect(analysis.rows.find((row) => row.span.name === 'raw-timing-root')!.outside).toBeNull();
  expect(analysis.rows.find((row) => row.span.name === 'zero-call')!.duration).toBe(0);
  expect(analysis.gaps).toEqual([{ start: Number(base / 1_000_000n) + 20, end: Number(base / 1_000_000n) + 95 }]);
  expect(analysis.incomplete).toBe(true);

  await open(page, `runs/${traceId}?view=timeline`);
  await page.getByTestId('run-views').getByRole('tab', { name: 'Timeline' }).click();
  const breakdown = page.getByTestId('timing-breakdown');
  await breakdown.locator('summary').click();
  const reversedRow = breakdown.getByRole('row').filter({ hasText: 'reversed-call' });
  await expect(reversedRow.getByRole('cell').nth(1)).toHaveText('Unavailable');
  await expect(reversedRow.getByRole('cell').nth(3)).toHaveText('Unavailable timing');
  await expect(breakdown.getByRole('row').filter({ hasText: 'raw-timing-root' }).getByRole('cell').nth(2)).toHaveText('Unavailable');
  await expect(breakdown.getByText(/Incomplete timing may hide activity/)).toBeVisible();
  await expect(breakdown.getByText('20 ms–95 ms: 75 ms', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('raw-timing.png'), fullPage: true });
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

for (const theme of ['light', 'dark', 'mobile'] as const) {
  test(`exact zero timing labels (${theme})`, async ({ page }, testInfo) => {
    const fixtures = [
      span('format-root', 0, 10, null, 'WORKFLOW'),
      span('exact-zero', 0, 0, 'format-root'),
      span('positive-sub-ms', 1, 1.5, 'format-root'),
      span('fully-covered', 2, 4, 'format-root'),
      span('covering-child', 2, 4, 'fully-covered'),
      { ...span('no-timing', 6, 6, 'format-root'), end_ns: '0' },
    ];
    await page.route(`${state().url}/api/runs/${state().supportRun}`, async (route) => {
      const response = await route.fetch();
      const original = await response.json();
      await route.fulfill({ response, json: { ...original, spans: fixtures } });
    });
    await open(page, `runs/${state().supportRun}?view=timeline`);
    if (theme === 'mobile') await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
    await page.getByTestId('run-views').getByRole('tab', { name: 'Timeline' }).click();
    const breakdown = page.getByTestId('timing-breakdown');
    await breakdown.locator('summary').click();
    const zero = breakdown.getByRole('row').filter({ hasText: 'exact-zero' });
    await expect(zero.getByRole('cell').nth(1)).toHaveText('0 ms');
    await expect(zero.getByRole('cell').nth(2)).toHaveText('0 ms');
    const covered = breakdown.getByRole('row').filter({ hasText: 'fully-covered' });
    await expect(covered.getByRole('cell').nth(1)).toHaveText('2 ms');
    await expect(covered.getByRole('cell').nth(2)).toHaveText('0 ms');
    const positive = breakdown.getByRole('row').filter({ hasText: 'positive-sub-ms' });
    await expect(positive.getByRole('cell').nth(1)).toHaveText('<1 ms');
    await expect(positive.getByRole('cell').nth(2)).toHaveText('<1 ms');
    const unavailable = breakdown.getByRole('row').filter({ hasText: 'no-timing' });
    await expect(unavailable.getByRole('cell').nth(1)).toHaveText('Unavailable');
    await expect(unavailable.getByRole('cell').nth(2)).toHaveText('Unavailable');
    await expect(breakdown.getByText('0 ms–1 ms: 1 ms', { exact: true })).toBeVisible();
    await breakdown.locator('summary + div').evaluate((element) => { element.scrollTop = 0; });
    await breakdown.locator('table').evaluate((element) => { element.parentElement!.scrollLeft = 0; });
    await page.screenshot({ path: testInfo.outputPath(`zero-${theme}.png`), fullPage: true });
  });
}
