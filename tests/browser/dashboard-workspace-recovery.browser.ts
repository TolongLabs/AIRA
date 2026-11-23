import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { queueModel, startApp } from '../support/app.js'

const TOKEN = 'fixture-owner'

async function auth(page: import('playwright').Page, origin: string) {
  await page.goto(origin + '/app/preview/chats')
  await page.getByPlaceholder('site token').fill(TOKEN)
  await page.getByRole('button', { name: 'Save token' }).click()
  await page
    .getByText(/Chats|Chat Directory|No chats yet/)
    .first()
    .waitFor()
}

it('dashboard workspace recovers from a missing lazy chunk', async () => {
  const host = createServer((request, response) => {
    if (request.headers['x-tolongai-token'] !== TOKEN) {
      response
        .writeHead(401, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'Owner token required' }))
      return
    }
    const value =
      request.url === '/api/dashboard'
        ? { services: { Core: 'active' }, brain: { note: 1 }, recent: [] }
        : request.url === '/api/cron'
          ? { jobs: [] }
          : undefined
    response.writeHead(value ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(value ?? {}))
  })
  await new Promise<void>((done) => host.listen(0, '127.0.0.1', done))
  const address = host.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener')
  try {
    const { app } = await startApp(queueModel([{ text: 'Unused fixture reply' }]), {
      env: { AIRA_OWNER_API_ORIGIN: 'http://127.0.0.1:' + address.port },
      siteDir: resolve('site/dist')
    })
    const site = await app.listenSite(0, '127.0.0.1')
    const origin = 'http://127.0.0.1:' + site.port
    const browser = await chromium.launch()
    const faults: string[] = []
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 810 } })
      const caughtWarnings: string[] = []
      page.on('console', (event) => {
        if (event.type() === 'warning') caughtWarnings.push(event.text())
      })
      const seen = new Set<string>()
      let blockNewChunks = false
      await page.route('**/*', (route) => {
        const url = new URL(route.request().url())
        if (url.origin !== origin) return route.abort()
        if (url.pathname.startsWith('/app/assets/') && url.pathname.endsWith('.js')) {
          if (blockNewChunks && !seen.has(url.href)) return route.abort('failed')
          seen.add(url.href)
        }
        return route.continue()
      })
      page.on('pageerror', (error) => faults.push(error.name + ': ' + error.message))

      await auth(page, origin)
      await page.goto(origin + '/app/preview/overview')
      await page.getByRole('heading', { name: 'Service Health' }).first().waitFor()

      blockNewChunks = true
      await page.goto(origin + '/app/preview/system/health')
      const alert = page.getByRole('alert')
      await alert.waitFor()
      await page.getByRole('heading', { name: 'This view needs a refresh' }).waitFor()
      expect(caughtWarnings).toContain('dashboard.workspace_failed')
      await page.getByRole('button', { name: 'Reload the dashboard' }).waitFor()
      await page.getByRole('link', { name: 'Back to Overview' }).waitFor()
      await page.getByRole('navigation', { name: 'Main navigation' }).waitFor()
      const alertText = (await alert.textContent()) ?? ''
      expect(alertText).not.toMatch(/Chunk|Failed to fetch|dynamically|404|assets\//)

      await page.waitForTimeout(750)
      expect(page.url()).toBe(origin + '/app/preview/system/health')
      expect(await alert.isVisible()).toBe(true)

      await page.getByRole('link', { name: 'Back to Overview' }).click()
      await page.getByRole('heading', { name: 'Service Health' }).first().waitFor()
      expect(page.url()).toBe(origin + '/app/preview/overview')

      await page.goto(origin + '/app/preview/system/health')
      await page.getByRole('heading', { name: 'This view needs a refresh' }).waitFor()

      blockNewChunks = false
      await page.getByRole('button', { name: /reload/i }).click()
      await page.getByRole('heading', { name: 'Service Health' }).first().waitFor()
      expect(page.url()).toBe(origin + '/app/preview/system/health')
      await page.getByText('Core', { exact: true }).waitFor()
      expect(await page.getByRole('heading', { name: 'This view needs a refresh' }).count()).toBe(0)

      expect(faults).toEqual([])
    } finally {
      await browser.close()
    }
  } finally {
    host.closeAllConnections()
    await new Promise<void>((done) => host.close(() => done()))
  }
})
