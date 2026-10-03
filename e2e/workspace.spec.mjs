import { test, expect } from '@playwright/test';

test('real webhook capture renders redacted details and deletion', async ({ page, request }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const endpoint = 'browser-' + testInfo.project.name + '-' + Date.now();
  const response = await request.post('/hooks/' + endpoint + '?source=fixture', {
    headers: { authorization: 'Bearer synthetic-test-secret', 'content-type': 'application/json' },
    data: { event: 'invoice.paid', amount: 42 },
  });
  expect(response.status()).toBe(202);
  await page.goto('/');
  await page.getByRole('searchbox', { name: 'Search', exact: true }).fill(endpoint);
  await page.getByRole('searchbox', { name: 'Search', exact: true }).press('Enter');
  await page.locator('.history-item').filter({ hasText: endpoint }).click();
  await expect(page.locator('#body-content')).toContainText('invoice.paid');
  await expect(page.locator('#query-table')).toContainText('fixture');
  await expect(page.locator('#header-table')).toContainText('[REDACTED]');
  await expect(page.locator('#header-table')).not.toContainText('synthetic-test-secret');
  await expect(page.getByRole('button', { name: 'Replay', exact: true })).toBeDisabled();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.history-item').filter({ hasText: endpoint })).toHaveCount(0);
  expect(errors).toEqual([]);
});
