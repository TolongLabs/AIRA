import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { AxeBuilder } from '@axe-core/playwright'
import { chromium } from 'playwright'
import { expect, it, vi } from 'vitest'
import { type App, createApp } from '../../src/app.js'
import { createLogger } from '../../src/records/logger.js'
import { queueModel } from '../support/app.js'
import { testConfig } from '../support/core.js'
import { tmpDir } from '../support/tmp.js'

it('walks standalone setup, saves private credentials and verifies activation after a restart', async () => {
  const root = tmpDir('aira-browser-standalone-')
  const restart = vi.fn()
  const model = queueModel([])
  const apps: App[] = []
  async function boot(port = 0) {
    const app = await createApp({
      config: testConfig((value) => {
        value.storage.path = root
        value.storage.minFreeMb = 2
        value.storage.criticalFreeMb = 1
        value.gateway.hostDataDir = root
      }),
      env: { AIRA_INSTALL_MODE: 'standalone' },
      siteDir: resolve('site/dist'),
      clients: { main: model },
      onActivationRequested: restart,
      logger: createLogger({ level: 'error', module: 'test', sink: () => undefined })
    })
    apps.push(app)
    await app.listen(0, '127.0.0.1')
    const site = await app.listenSite(port, '127.0.0.1')
    app.completeStartup()
    return { app, port: site.port }
  }
  const cold = await boot()
  const origin = `http://127.0.0.1:${cold.port}`
  const token = readFileSync(join(root, 'standalone', 'owner.token'), 'utf8').trim()
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 810 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    const hostRequests: string[] = []
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url())
      if (url.origin !== origin) return route.abort()
      if (url.pathname.startsWith('/owner-api/') && !url.pathname.startsWith('/owner-api/core/')) {
        hostRequests.push(url.pathname)
        return route.abort()
      }
      return route.continue()
    })
    await page.goto(origin + '/app/preview/overview')
    await page.getByPlaceholder('site token').fill(token)
    await page.getByRole('button', { name: 'Save token' }).click()
    await page.getByText('Configure the main model.').waitFor()
    await page.getByText('aira attach-hermes --profile default --dry-run', { exact: true }).waitFor()
    await page.getByRole('link', { name: 'System Settings', exact: true }).click()
    const secret = 'synthetic-onboarding-key-canary'
    await page.locator('#standalone-main-provider').fill('openai-compatible')
    await page.locator('#standalone-main-model').fill('fixture-model')
    await page.locator('#standalone-main-base').fill('http://127.0.0.1:12345/v1')
    await page.locator('#standalone-main-key').fill(secret)
    await page.getByRole('button', { name: 'Save revision' }).click()
    await page.getByText('Saved, waiting to apply', { exact: true }).waitFor()
    expect(await page.locator('#standalone-main-key').inputValue()).toBe('')
    expect(await page.content()).not.toContain(secret)
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(secret)
    await page.getByRole('button', { name: 'Apply saved revision' }).click()
    await expect.poll(() => restart.mock.calls.length).toBe(1)
    await cold.app.close()
    const applied = await boot(cold.port)
    await page.getByText('Running the saved revision.').waitFor()
    expect(model.requests).toHaveLength(0)
    await page.setViewportSize({ width: 320, height: 704 })
    expect(await page.locator('html').evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(320)
    const audit = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(audit.violations.map((row) => row.id)).toEqual([])
    await page.goto(origin + '/app/preview/markets')
    await page.getByText(/capability_unavailable/).waitFor()
    await page.goto(origin + '/app/preview/characters')
    await page.getByText('Example', { exact: true }).first().waitFor()
    await page.goto(origin + '/app/preview/chats/defaults')
    await page.getByText(/Standalone supports text replies only/).waitFor()
    expect(await page.getByText('Send a sticker with replies', { exact: true }).count()).toBe(0)
    expect(hostRequests).toEqual([])
    await applied.app.close()
  } finally {
    await browser.close()
    for (const app of apps) await app.close()
  }
})
