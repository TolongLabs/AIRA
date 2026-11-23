import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { AxeBuilder } from '@axe-core/playwright'
import { chromium, firefox, webkit } from 'playwright'
import { expect } from 'playwright/test'
import { it } from 'vitest'
import { queueModel, startApp } from '../support/app.js'

// Synthetic loopback graph: invented ids only, no real names or chats.
const GRAPH = {
  nodes: [
    { id: 'song:alpha', type: 'song', label: 'Alpha', url: 'song:alpha', owner: 'test-chat-g1', done: null },
    { id: 'vocab:beta', type: 'vocab', label: 'Beta', url: 'vocab:beta', owner: 'test-chat-g1', done: null },
    { id: 'note:gamma', type: 'note', label: 'Gamma', url: 'note:gamma' }
  ],
  edges: [
    { s: 'song:alpha', t: 'vocab:beta', r: 'mentions' },
    { s: 'song:alpha', t: 'note:gamma', r: 'filed-with' }
  ],
  counts: { song: 1, vocab: 1, note: 1 }
}

for (const engine of [chromium, firefox, webkit]) {
  it('graph keyboard, 320px reflow and deep links in ' + engine.name(), async () => {
    const host = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/api/graph') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(GRAPH))
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({}))
    })
    await new Promise<void>((done) => host.listen(0, '127.0.0.1', done))
    const address = host.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture listener')
    try {
      const { app } = await startApp(queueModel([]), {
        env: { AIRA_OWNER_API_ORIGIN: 'http://127.0.0.1:' + address.port },
        siteDir: resolve('site/dist')
      })
      const site = await app.listenSite(0, '127.0.0.1')
      const origin = 'http://127.0.0.1:' + site.port
      const browser = await engine.launch()
      try {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })
        const page = await context.newPage()
        await page.route('**/*', (route) =>
          new URL(route.request().url()).origin === origin ? route.continue() : route.abort()
        )
        const faults: string[] = []
        page.on('pageerror', (err) => faults.push(err.name))

        // Classic entry loads the same canvas without dashboard chrome.
        await page.goto(origin + '/app/graph.html')
        const canvas = page.getByRole('application', { name: /Knowledge graph/ })
        await canvas.waitFor()
        await page.getByLabel('Search nodes').waitFor()
        await page.getByText('3 nodes · 2 edges').waitFor()

        // Narrow viewport: search and inspector fit, nothing scrolls sideways.
        await page.setViewportSize({ width: 320, height: 704 })
        await expect.poll(() => page.locator('html').evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(320)
        const searchBox = (await page.getByLabel('Search nodes').boundingBox())!
        expect(searchBox.x).toBeGreaterThanOrEqual(0)
        expect(searchBox.x + searchBox.width).toBeLessThanOrEqual(320)

        // Keyboard browse: arrows select, focus stays on the canvas for discovery.
        await canvas.focus()
        await page.keyboard.press('ArrowRight')
        const dialog = page.getByRole('dialog', { name: 'Details for Alpha' })
        await dialog.waitFor()
        await expect(page.locator('#graph-kb-status')).toContainText('Alpha')
        expect(await canvas.evaluate((el) => el.ownerDocument.activeElement === el)).toBe(true)

        // Enter moves into the panel; Escape closes and returns to the canvas.
        await page.keyboard.press('Enter')
        const close = page.getByRole('button', { name: 'Close Alpha details' })
        await expect(close).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()
        expect(await canvas.evaluate((el) => el.ownerDocument.activeElement === el)).toBe(true)

        // Inspector fits at 320px when open.
        await page.keyboard.press('ArrowRight')
        await dialog.waitFor()
        const panelBox = (await dialog.boundingBox())!
        expect(panelBox.x).toBeGreaterThanOrEqual(0)
        expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(320)
        await page.keyboard.press('Escape')

        // Search narrows keyboard walk to the match.
        await page.getByLabel('Search nodes').fill('beta')
        await expect(page.locator('#graph-kb-status')).toContainText('1 nodes match')
        await canvas.focus()
        await page.keyboard.press('ArrowRight')
        await page.getByRole('dialog', { name: 'Details for Beta' }).waitFor()
        await page.keyboard.press('Escape')
        await page.getByLabel('Search nodes').fill('')

        // Dashboard deep link selects the same panel without stealing focus.
        await page.setViewportSize({ width: 1280, height: 800 })
        await page.goto(origin + '/app/preview/library/graph?focus=' + encodeURIComponent('song:alpha'))
        await page.getByRole('dialog', { name: 'Details for Alpha' }).waitFor()
        const focusInDialog = await page
          .locator('html')
          .evaluate((el) => !!el.ownerDocument.activeElement?.closest('[role="dialog"]'))
        expect(focusInDialog).toBe(false)

        const audit = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze()
        expect(audit.violations.map((row) => ({ id: row.id, targets: row.nodes.map((node) => node.target) }))).toEqual(
          []
        )
        expect(faults).toEqual([])
      } finally {
        await browser.close()
      }
    } finally {
      host.closeAllConnections()
      await new Promise<void>((done) => host.close(() => done()))
    }
  })
}
