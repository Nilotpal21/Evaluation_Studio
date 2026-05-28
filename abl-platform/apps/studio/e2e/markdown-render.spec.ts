/**
 * Markdown Rendering Test — dev@kore.ai
 *
 * Send targeted prompts that force markdown responses WITHOUT code fences,
 * then inspect the rendered HTML to verify each element type.
 */

import { test, expect } from '@playwright/test';

const STUDIO_URL = 'http://localhost:5173';

test.setTimeout(180_000);

async function loginAndOpenChat(page: import('@playwright/test').Page) {
  const resp = await page.request.post(`${STUDIO_URL}/api/auth/dev-login`, {
    data: { email: 'dev@kore.ai', name: 'Developer' },
  });
  expect(resp.ok()).toBe(true);

  await page.goto(STUDIO_URL);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2000);
  await page.getByText('weather App').first().click();
  await page.waitForTimeout(2000);
  await page.getByText('Agents').first().click();
  await page.waitForTimeout(2000);
  await page.locator('text=weather age').first().click();
  await page.waitForTimeout(2000);
  await page.getByText('Chat with Agent').click();
  await page.waitForTimeout(3000);
  await page.getByText('New Chat').first().click();
  await page.waitForTimeout(5000);

  return page.locator('textarea[placeholder*="message" i]').first();
}

async function sendAndCapture(
  page: import('@playwright/test').Page,
  chatInput: import('@playwright/test').Locator,
  prompt: string,
  label: string,
) {
  await chatInput.fill(prompt);
  await chatInput.press('Enter');
  console.log(`>>> Sent: ${label}`);
  await page.waitForTimeout(12000);

  // Get the last assistant bubble's HTML
  const bubbles = page.locator('[data-testid="message-list"] > div');
  const count = await bubbles.count();
  const lastBubble = bubbles.nth(count - 1);
  const html = await lastBubble.innerHTML().catch(() => '');
  const text = await lastBubble.innerText().catch(() => '');

  await page.screenshot({ path: `e2e/screenshots/md-${label}.png` });

  return { html, text };
}

test('verify all markdown element types render correctly', async ({ page }) => {
  const chatInput = await loginAndOpenChat(page);
  await expect(chatInput).toBeEnabled({ timeout: 15_000 });

  // --- 1. Headings ---
  const h = await sendAndCapture(
    page,
    chatInput,
    'Reply with exactly this text (no code fences, just raw markdown):\n# Main Title\n## Section\n### Subsection\nSome paragraph text here.',
    '01-headings',
  );
  console.log('Headings HTML:', h.html.slice(0, 300));
  const hasH1 = h.html.includes('<h1>');
  const hasH2 = h.html.includes('<h2>');
  const hasH3 = h.html.includes('<h3>');
  console.log(`  h1: ${hasH1}, h2: ${hasH2}, h3: ${hasH3}`);

  // --- 2. Bold + Italic ---
  const bi = await sendAndCapture(
    page,
    chatInput,
    'Reply with exactly: This has **bold text** and *italic text* and ***bold italic*** in one sentence.',
    '02-bold-italic',
  );
  console.log('Bold/Italic HTML:', bi.html.slice(0, 300));
  const hasStrong = bi.html.includes('<strong>');
  const hasEm = bi.html.includes('<em>');
  console.log(`  strong: ${hasStrong}, em: ${hasEm}`);

  // --- 3. Table ---
  const tbl = await sendAndCapture(
    page,
    chatInput,
    'Reply with exactly this markdown table (no code fences around it):\n\n| City | Temp | Humidity |\n|------|------|----------|\n| NYC  | 15°C | 60%      |\n| London | 12°C | 75%    |',
    '03-table',
  );
  console.log('Table HTML:', tbl.html.slice(0, 400));
  const hasTable = tbl.html.includes('<table>');
  const hasTh = tbl.html.includes('<th>');
  const hasTd = tbl.html.includes('<td>');
  console.log(`  table: ${hasTable}, th: ${hasTh}, td: ${hasTd}`);

  // --- 4. Code block ---
  const code = await sendAndCapture(
    page,
    chatInput,
    'Reply with a short Python hello world inside a fenced code block with python language tag.',
    '04-code',
  );
  console.log('Code HTML:', code.html.slice(0, 400));
  const hasPre = code.html.includes('<pre>');
  const hasCodeTag = code.html.includes('<code');
  const hasLangClass = code.html.includes('language-');
  console.log(`  pre: ${hasPre}, code: ${hasCodeTag}, langClass: ${hasLangClass}`);

  // --- 5. Lists ---
  const lists = await sendAndCapture(
    page,
    chatInput,
    'Reply with exactly:\n- First item\n- Second item\n- Third item\n\n1. Step one\n2. Step two\n3. Step three',
    '05-lists',
  );
  console.log('Lists HTML:', lists.html.slice(0, 400));
  const hasUl = lists.html.includes('<ul>');
  const hasOl = lists.html.includes('<ol>');
  const hasLi = lists.html.includes('<li>');
  console.log(`  ul: ${hasUl}, ol: ${hasOl}, li: ${hasLi}`);

  // --- 6. Blockquote + inline code + link ---
  const misc = await sendAndCapture(
    page,
    chatInput,
    'Reply with exactly:\n> This is a blockquote about weather\n\nUse `get_weather()` to fetch data.\n\nVisit [Weather API](https://example.com) for more info.',
    '06-blockquote-code-link',
  );
  console.log('Misc HTML:', misc.html.slice(0, 400));
  const hasBlockquote = misc.html.includes('<blockquote>');
  const hasInlineCode = misc.html.includes('<code>');
  const hasLink = misc.html.includes('<a ');
  console.log(`  blockquote: ${hasBlockquote}, inlineCode: ${hasInlineCode}, link: ${hasLink}`);

  // --- Summary ---
  console.log('\n=== MARKDOWN RENDERING SUMMARY ===');
  const results = [
    { feature: 'Headings (h1/h2/h3)', pass: hasH1 || hasH2 || hasH3 },
    { feature: 'Bold (<strong>)', pass: hasStrong },
    { feature: 'Italic (<em>)', pass: hasEm },
    { feature: 'Table (<table>)', pass: hasTable },
    { feature: 'Code block (<pre>)', pass: hasPre },
    { feature: 'Language class', pass: hasLangClass },
    { feature: 'Unordered list (<ul>)', pass: hasUl },
    { feature: 'Ordered list (<ol>)', pass: hasOl },
    { feature: 'Blockquote', pass: hasBlockquote },
    { feature: 'Inline code', pass: hasInlineCode },
    { feature: 'Link (<a>)', pass: hasLink },
  ];

  for (const r of results) {
    console.log(`  ${r.pass ? '✅' : '❌'} ${r.feature}`);
  }

  const passCount = results.filter((r) => r.pass).length;
  console.log(`\n${passCount}/${results.length} features rendering correctly`);
});
