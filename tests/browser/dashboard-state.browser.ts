import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { chromium, firefox, webkit } from 'playwright'
import { expect, it } from 'vitest'
import { ensureChat, setChatLabel, setChatStatus } from '../../src/settings/chats.js'
import { queueModel, startApp } from '../support/app.js'

const TOKEN = 'fixture-owner'
const COPY_ID = 'fixture-copy'

async function auth(page: import('playwright').Page, origin: string) {
  await page.goto(origin + '/app/preview/chats')
  const tokenInput = page.getByPlaceholder('site token')
  const saveButton = page.getByRole('button', { name: 'Save token' })
  await tokenInput.fill(TOKEN)
  await saveButton.click()
  await page
    .getByText(/Chats|Chat Directory|No chats yet/)
    .first()
    .waitFor()
}

async function coreFetch(origin: string, path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  headers.set('accept', 'application/json')
  headers.set('x-tolongai-token', TOKEN)
  if (init?.body !== undefined) headers.set('content-type', 'application/json')
  headers.set('origin', origin)
  const res = await fetch(origin + path, { ...init, headers })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, body }
}

for (const engine of [chromium, firefox, webkit]) {
  it('dashboard state keeps drafts, shows source and survives external pack edits in ' + engine.name(), async () => {
    const host = createServer(async (request, response) => {
      if (request.headers['x-tolongai-token'] !== TOKEN) {
        response
          .writeHead(401, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'Owner token required' }))
        return
      }
      const value =
        request.url === '/api/settings'
          ? { markets: {} }
          : request.url === '/api/dashboard'
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
      const { app, gateway } = await startApp(queueModel([{ text: 'Fixture happy path reply' }]), {
        env: { AIRA_OWNER_API_ORIGIN: 'http://127.0.0.1:' + address.port },
        siteDir: resolve('site/dist')
      })
      const chat = ensureChat(app.storage, { waId: 'fixture-group', type: 'group' })
      setChatLabel(app.storage, { chatId: chat.chatId, label: 'Field Notes', actor: 'fixture' })
      setChatStatus(app.storage, { chatId: chat.chatId, status: 'active', actor: 'fixture' })
      const site = await app.listenSite(0, '127.0.0.1')
      const origin = 'http://127.0.0.1:' + site.port
      const browser = await engine.launch()
      const faults: string[] = []
      try {
        const ctxA = await browser.newContext({ viewport: { width: 1440, height: 810 } })
        const ctxB = await browser.newContext({ viewport: { width: 1440, height: 810 } })
        const pageA = await ctxA.newPage()
        const pageB = await ctxB.newPage()
        for (const page of [pageA, pageB]) {
          await page.route('**/*', (route) =>
            new URL(route.request().url()).origin === origin ? route.continue() : route.abort()
          )
          page.on('pageerror', (err) => faults.push(err.name + ': ' + err.message))
        }

        await auth(pageA, origin)
        await auth(pageB, origin)

        // Editable copy of the built-in pack, made through the Studio UI.
        await pageA.goto(origin + '/app/preview/characters/example/edit')
        await pageA.getByText(/built-in repository pack/).waitFor()
        await pageA.getByPlaceholder('my-character').fill(COPY_ID)
        await pageA.getByRole('button', { name: 'Copy to editable pack' }).click()
        await pageA.waitForURL('**/characters/' + COPY_ID + '/edit')
        await pageA.getByRole('navigation', { name: 'Editor sections' }).waitFor()

        // Select the editable copy in chat settings on both contexts.
        const settingsUrl = origin + '/app/preview/chats/' + encodeURIComponent(chat.chatId) + '/settings'
        await pageA.goto(settingsUrl)
        await pageA.getByRole('radio', { name: new RegExp(COPY_ID) }).click()
        await pageA.getByText('Saved for this chat.').waitFor()
        await pageB.goto(settingsUrl)
        await pageB.getByRole('tab', { name: 'Character' }).click()
        await pageB.getByText('set here').first().waitFor()

        // Competing scoped saves: A wins, B keeps its draft on the conflict.
        for (const page of [pageA, pageB]) {
          await page.goto(settingsUrl)
          await page.getByRole('tab', { name: 'Reply' }).click()
          await page.getByLabel('Context size').waitFor()
        }
        await pageA.getByLabel('Context size').fill('42')
        await pageA.getByLabel('Context size').press('Enter')
        await pageA.getByText('Saved for this chat.').waitFor()
        await pageA.getByText('set here').first().waitFor()

        await pageB.getByLabel('Context size').fill('43')
        await pageB.getByLabel('Context size').press('Enter')
        await pageB.getByRole('heading', { name: 'Settings changed in another session' }).waitFor()
        expect(await pageB.getByLabel('Context size').inputValue()).toBe('43')

        // Reload shows the winner, then clearing restores visible inheritance.
        await pageB.goto(settingsUrl)
        await pageB.getByRole('tab', { name: 'Reply' }).click()
        expect(await pageB.getByLabel('Context size').inputValue()).toBe('42')
        await pageB
          .getByText('Context size', { exact: true })
          .locator('xpath=../..')
          .getByRole('button', { name: 'Use inherited' })
          .click()
        await pageB.getByText('This chat now inherits it.').waitFor()
        await pageB.getByText('built-in default').first().waitFor()

        // Studio control plane: read revision, publish a display-name change.
        const studioPath = '/owner-api/core/characters/' + COPY_ID + '/studio'
        const first = await coreFetch(origin, studioPath)
        expect(first.status).toBe(200)
        const firstRevision = (first.body as { revision: string }).revision
        expect(firstRevision).toMatch(/^[0-9a-f]{64}$/)
        const cardDir = join(app.paths.root, 'characters', COPY_ID)
        const cardPath = join(cardDir, 'card.yml')
        const cleanBytes = readFileSync(cardPath)

        const renamed = await coreFetch(origin, studioPath, {
          method: 'PUT',
          body: JSON.stringify({ expectedRevision: firstRevision, patch: { card: { displayName: 'Fixture Copy' } } })
        })
        expect(renamed.status).toBe(200)
        const secondRevision = (renamed.body as { revision: string }).revision
        expect(secondRevision).not.toBe(firstRevision)

        // External valid YAML edit: stale coordinated write loses, bytes stay, refetch sees the edit.
        const externalText = readFileSync(cardPath, 'utf8').replace('Fixture Copy', 'Fixture External')
        writeFileSync(cardPath, externalText)
        const stale = await coreFetch(origin, studioPath, {
          method: 'PUT',
          body: JSON.stringify({ expectedRevision: secondRevision, patch: { card: { displayName: 'Fixture Stale' } } })
        })
        expect(stale.status).toBe(409)
        expect((stale.body as { error: string }).error).toBe('stale_revision')
        expect(readFileSync(cardPath, 'utf8')).toContain('Fixture External')
        const refetched = await coreFetch(origin, studioPath)
        expect(refetched.status).toBe(200)
        expect((refetched.body as { card: { displayName: string } }).card.displayName).toBe('Fixture External')
        const externalRevision = (refetched.body as { revision: string }).revision
        expect(externalRevision).not.toBe(secondRevision)

        // External malformed YAML: bytes stay, refetch fails safe, editor shows the fault.
        writeFileSync(cardPath, ':\n: bad: [unclosed\n')
        expect(readFileSync(cardPath, 'utf8')).toContain('bad: [unclosed')
        const broken = await coreFetch(origin, studioPath)
        expect(broken.status).toBe(409)
        expect((broken.body as { error: string }).error).toBe('pack_unparseable')
        await pageA.goto(origin + '/app/preview/characters/' + COPY_ID + '/edit')
        await pageA
          .getByRole('alert')
          .filter({ hasText: /Could not load this pack/ })
          .waitFor()
        expect(readFileSync(cardPath, 'utf8')).toContain('bad: [unclosed')

        // Repair, then one happy path from Studio through control to the next turn.
        writeFileSync(cardPath, cleanBytes)
        const repaired = await coreFetch(origin, studioPath)
        expect(repaired.status).toBe(200)
        const repairedRevision = (repaired.body as { revision: string }).revision
        const published = await coreFetch(origin, studioPath, {
          method: 'PUT',
          body: JSON.stringify({ expectedRevision: repairedRevision, patch: { card: { displayName: 'Fixture Copy' } } })
        })
        expect(published.status).toBe(200)

        const chatsRes = await coreFetch(origin, '/owner-api/core/chats')
        expect(chatsRes.status).toBe(200)
        const chats = (chatsRes.body as { chats: { chatId: string; settings: Record<string, { value: unknown }> }[] })
          .chats
        expect(chats.find((row) => row.chatId === chat.chatId)?.settings['character']?.value).toBe(COPY_ID)

        const delivery = await gateway.send({
          chat: { waId: 'fixture-group', kind: 'group' },
          sender: 'fixture-member',
          mid: 'fixture-mid-1',
          text: 'hello from the dashboard state test'
        })
        expect(delivery.status).toBe('delivered')
        expect(delivery.bubbles.length).toBeGreaterThan(0)
        const turn = app.storage.read(
          (db) => db.prepare('SELECT chat_id FROM turn ORDER BY received_at DESC LIMIT 1').get() as { chat_id: string }
        )
        expect(turn.chat_id).toBe(chat.chatId)

        await ctxA.close()
        await ctxB.close()
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
