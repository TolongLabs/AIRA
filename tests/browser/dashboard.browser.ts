import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { AxeBuilder } from '@axe-core/playwright'
import { chromium, firefox, webkit } from 'playwright'
import { expect, it } from 'vitest'
import { ensureChat, setChatLabel } from '../../src/settings/chats.js'
import { queueModel, startApp } from '../support/app.js'

for (const engine of [chromium, firefox, webkit]) {
  it('opens the production preview, follows links and restores phone focus in ' + engine.name(), async () => {
    let dispatches = 0
    let mode: 'accept' | 'refuse' | 'disconnect' = 'accept'
    const host = createServer(async (request, response) => {
      if (request.url === '/api/settings' || request.url === '/api/chats/intro') {
        if (request.headers['x-tolongai-token'] !== 'fixture-owner') {
          response.writeHead(401).end()
          return
        }
        if (request.url === '/api/chats/intro') {
          const chunks: Buffer[] = []
          for await (const chunk of request) chunks.push(Buffer.from(chunk))
          const body = JSON.parse(Buffer.concat(chunks).toString())
          if (mode === 'refuse') {
            response
              .writeHead(400, { 'content-type': 'application/json' })
              .end(JSON.stringify({ error: 'invalid_target' }))
            return
          }
          dispatches++
          if (mode === 'disconnect') {
            response.destroy()
            return
          }
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ target: body.target, text: body.text, sent_at: null }))
          return
        }
      }
      const fixture: Record<string, unknown> = {
        '/api/dashboard': {
          services: { Core: 'active', Gateway: 'active', 'Owner Service': 'active', Scheduler: 'active' },
          brain: { note: 3 },
          recent: []
        },
        '/api/cron': { jobs: [] },
        '/api/settings': { markets: {} }
      }
      const value = fixture[request.url ?? '']
      response.writeHead(value ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(value ?? {}))
    })
    await new Promise<void>((done) => host.listen(0, '127.0.0.1', done))
    const address = host.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture listener')
    try {
      const { app } = await startApp(queueModel([]), {
        env: { AIRA_OWNER_API_ORIGIN: 'http://127.0.0.1:' + address.port },
        siteDir: resolve('site/dist')
      })
      const fixture = ensureChat(app.storage, { waId: 'fixture-group', type: 'group' })
      setChatLabel(app.storage, { chatId: fixture.chatId, label: 'Field Notes', actor: 'fixture' })
      const site = await app.listenSite(0, '127.0.0.1')
      const origin = 'http://127.0.0.1:' + site.port
      const browser = await engine.launch()
      try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 810 }, reducedMotion: 'reduce' })
        const page = await context.newPage()
        await page.route('**/*', (route) =>
          new URL(route.request().url()).origin === origin ? route.continue() : route.abort()
        )
        async function capture(name: string) {
          const folder = process.env.AIRA_DASHBOARD_EVIDENCE_DIR
          if (engine !== chromium || !folder) return
          await mkdir(folder, { recursive: true })
          await page.evaluate('document.fonts.ready.then(() => true)')
          await page.screenshot({ path: resolve(folder, name + '.png'), animations: 'disabled' })
        }
        const faults: string[] = []
        page.on('pageerror', (err) => faults.push(err.name))
        await page.goto(origin + '/app/preview/overview')
        await page.getByText('4/4', { exact: true }).waitFor()
        await page.getByPlaceholder('site token').fill('fixture-owner')
        await page.getByRole('button', { name: 'Save token' }).click()
        await page.getByText('1 Pending', { exact: true }).waitFor()
        await page.getByText('3 saved items', { exact: true }).waitFor()
        await capture('overview-light')
        await page.getByRole('button', { name: 'Switch to dark mode' }).click()
        await capture('overview-dark')
        await page.getByRole('button', { name: 'Switch to light mode' }).click()
        await page.setViewportSize({ width: 396, height: 704 })
        await capture('overview-phone')
        await page.setViewportSize({ width: 1440, height: 810 })
        await page.getByRole('button', { name: 'Collapse sidebar' }).click()
        await page.getByRole('button', { name: 'Expand sidebar' }).waitFor()
        await page.getByRole('link', { name: /4 of 4 Online/ }).click()
        await page.reload()
        await page.getByRole('heading', { name: 'Service Health' }).waitFor()
        await page.goBack()
        await page.setViewportSize({ width: 320, height: 704 })
        const open = page.getByRole('button', { name: 'Open navigation' })
        await open.click()
        await page.getByRole('dialog').waitFor()
        await page.keyboard.press('Escape')
        expect(await open.evaluate((el) => el.ownerDocument.activeElement === el)).toBe(true)
        expect(await page.locator('html').evaluate((el) => el.scrollWidth)).toBeLessThanOrEqual(320)
        const audit = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze()
        expect(audit.violations.map((row) => row.id)).toEqual([])
        await open.click()
        for (let n = 0; n < 21; n++) {
          const row = ensureChat(app.storage, { waId: 'fixture-page-' + n, type: 'dm' })
          setChatLabel(app.storage, {
            chatId: row.chatId,
            label: 'Zeta ' + String(n).padStart(2, '0'),
            actor: 'fixture'
          })
        }
        await page.getByRole('dialog').getByRole('link', { name: 'Chats', exact: true }).click()
        const selected = page.getByRole('checkbox', { name: 'Select Field Notes', exact: true })
        await selected.check()
        expect(
          await page
            .getByRole('checkbox', { name: /Select this page/ })
            .evaluate((el) => 'indeterminate' in el && el.indeterminate)
        ).toBe(true)
        await page.getByRole('button', { name: /Next/ }).click()
        await page.getByRole('button', { name: /Previous/ }).click()
        expect(await selected.isChecked()).toBe(true)
        await page.getByRole('searchbox').fill('Field Notes')
        expect(await selected.isChecked()).toBe(false)
        await page.getByRole('link', { name: 'Field Notes' }).click()
        await page.getByRole('link', { name: 'Send Message' }).click()
        await page.getByLabel('Message', { exact: true }).fill('Fictional fixture message')
        await page.getByRole('button', { name: 'Review Message' }).click()
        await capture('chat-confirm')
        expect(dispatches).toBe(0)
        await page.getByRole('button', { name: 'Confirm Send' }).click()
        await page.getByText('Gateway acknowledged the message.').waitFor()
        await page.reload()
        await page.getByText('Gateway acknowledged the message.').waitFor()
        expect(dispatches).toBe(1)
        await page.getByRole('button', { name: 'New Message' }).click()
        const draft = page.getByLabel('Message', { exact: true })
        mode = 'refuse'
        await draft.fill('Fictional refused draft')
        await page.getByRole('button', { name: 'Review Message' }).click()
        await page.getByRole('button', { name: 'Confirm Send' }).click()
        await page.getByRole('button', { name: 'Edit Draft' }).click()
        expect(await draft.inputValue()).toBe('Fictional refused draft')
        mode = 'disconnect'
        await page.getByRole('button', { name: 'Review Message' }).click()
        await page.getByRole('button', { name: 'Confirm Send' }).click()
        await page.getByText('The send outcome is unknown.').waitFor()
        await page.reload()
        await page.getByRole('button', { name: 'Check Status' }).click()
        expect(dispatches).toBe(2)
        await page.goto(origin + '/app/preview/system/appearance')
        const lattice = page.locator('input[value=lattice]')
        await lattice.check()
        await page.locator('.dashboard-backdrop--lattice').waitFor()
        await page.getByRole('button', { name: 'Cancel', exact: true }).click()
        await page.locator('.dashboard-backdrop--plain').waitFor()
        await lattice.check()
        await page.getByRole('button', { name: 'Apply', exact: true }).click()
        await page.reload()
        await page.locator('.dashboard-backdrop--lattice').waitFor()
        expect(await lattice.isChecked()).toBe(true)
        await page.goto(origin + '/app/preview/characters/example/edit')
        await page.getByPlaceholder('my-character').fill('sample-copy')
        await page.getByRole('button', { name: 'Copy to editable pack' }).click()
        await page.waitForURL('**/characters/sample-copy/edit')
        await page.getByRole('navigation', { name: 'Editor sections' }).waitFor()
        await page.setViewportSize({ width: 1440, height: 810 })
        await capture('studio-editor')
        await page.goto(origin + '/app/preview/characters/sample-copy/footer')
        await page
          .getByRole('heading', { name: /tool footer/i })
          .first()
          .waitFor()
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
