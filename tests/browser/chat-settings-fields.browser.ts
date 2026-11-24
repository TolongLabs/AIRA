import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { expect } from 'playwright/test'
import { it } from 'vitest'
import { ensureChat, setChatLabel, setChatStatus } from '../../src/settings/chats.js'
import { queueModel, startApp } from '../support/app.js'

// Field-level verification of the editable controls in Chat Settings and Chat
// Defaults (docs/trd/dashboard-state.md#chat-type-and-global-settings).
//
// One Chromium journey: chat scope on a synthetic group, type/global scope on
// the defaults page, then a next turn. Every field is inventoried as an
// editable control or a truthful read-only/internal classification; only a
// representative subset is changed and cleared to keep the run under the
// browser timeout. Scoped DOM locators and polling expects throughout.

const TOKEN = 'fixture-fields-owner'
const GROUP_WAID = 'fixture-fields-group'
const DM_WAID = 'fixture-fields-dm'
const MEMBER = 'fixture-fields-member'

async function auth(page: import('playwright').Page, origin: string) {
  await page.goto(origin + '/app/preview/chats')
  await page.getByPlaceholder('site token').fill(TOKEN)
  await page.getByRole('button', { name: 'Save token' }).click()
  await expect(page.getByRole('link', { name: 'Field Inventory', exact: true })).toBeVisible()
}

it('chat settings fields show controls, sources, clear and next turn in chromium', async () => {
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
    const model = queueModel([{ text: 'Fixture fields happy path reply' }])
    const { app, gateway } = await startApp(model, {
      env: { AIRA_OWNER_API_ORIGIN: 'http://127.0.0.1:' + address.port },
      siteDir: resolve('site/dist')
    })
    const chat = ensureChat(app.storage, { waId: GROUP_WAID, type: 'group' })
    setChatLabel(app.storage, { chatId: chat.chatId, label: 'Field Inventory', actor: 'fixture' })
    setChatStatus(app.storage, { chatId: chat.chatId, status: 'active', actor: 'fixture' })
    const dm = ensureChat(app.storage, { waId: DM_WAID, type: 'dm' })
    setChatStatus(app.storage, { chatId: dm.chatId, status: 'active', actor: 'fixture' })
    const site = await app.listenSite(0, '127.0.0.1')
    const origin = 'http://127.0.0.1:' + site.port
    const browser = await chromium.launch()
    const faults: string[] = []
    try {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 810 } })
      const page = await ctx.newPage()
      page.setDefaultTimeout(5000)
      await page.route('**/*', (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort()
      )
      page.on('pageerror', (err) => faults.push(err.name + ': ' + err.message))

      await auth(page, origin)
      const settingsUrl = origin + '/app/preview/chats/' + encodeURIComponent(chat.chatId) + '/settings'
      await page.goto(settingsUrl)
      const panel = page.getByRole('tabpanel')
      const tab = (name: string) => page.getByRole('tab', { name, exact: true })
      const rowHeader = (field: string) => panel.getByText(field, { exact: true }).first().locator('xpath=..')
      const clear = async (field: string) => {
        const header = rowHeader(field)
        await expect(header.getByText('set here', { exact: true })).toBeVisible()
        await header.getByRole('button', { name: 'Use inherited', exact: true }).click()
        await expect(header.getByRole('button', { name: 'Use inherited', exact: true })).toHaveCount(0)
      }
      await expect(tab('Character')).toBeVisible()

      await expect(page.getByRole('heading', { name: 'Chat Settings', level: 1 })).toBeVisible()
      const folder = process.env.AIRA_DASHBOARD_EVIDENCE_DIR
      if (folder) {
        await mkdir(folder, { recursive: true })
        await page.evaluate('document.fonts.ready.then(() => true)')
        await page.screenshot({ path: resolve(folder, 'chat-settings.png'), animations: 'disabled' })
      }
      // Access owns the reply switch and owner label.
      await tab('Access').click()
      const replies = page.getByRole('switch', { name: 'Replies in this chat' })
      await expect(replies).toBeChecked()
      await replies.click()
      await expect(replies).not.toBeChecked()
      await replies.click()
      await expect(replies).toBeChecked()
      const labelInput = page.getByLabel(/Label for/)
      await expect(labelInput).toHaveValue('Field Inventory')
      await labelInput.fill('Field Labels')
      await labelInput.press('Enter')
      await expect(page.getByLabel('Label for Field Labels', { exact: true })).toHaveValue('Field Labels')
      await labelInput.fill('')
      await labelInput.press('Enter')
      await expect(page.getByText('Cleared label for this chat.', { exact: true }).last()).toBeVisible()
      await expect(page.getByLabel('Label for Field Labels', { exact: true })).toHaveCount(0)

      // Character tab: character choice inventoried, language changed and cleared.
      await tab('Character').click()
      await expect(panel.getByText('Character', { exact: true })).toBeVisible()
      const characterChoice = panel.getByRole('group', { name: 'Choose a character' })
      const characterPicker = panel.getByRole('button', { name: /^character,/ })
      await expect(characterChoice.or(characterPicker).first()).toBeVisible()
      const language = panel.getByLabel('language code')
      await expect(language).toHaveValue('auto')
      await language.fill('ms')
      await language.press('Enter')
      await expect(language).toHaveValue('ms')
      await clear('Language')
      await expect(panel.getByLabel('language code')).toHaveValue('auto')

      // Reply tab: representative changes plus a full control inventory.
      await tab('Reply').click()
      await expect(panel.getByText('Reply length', { exact: true })).toBeVisible()
      await panel.getByRole('button', { name: 'Short' }).click()
      await expect(panel.getByRole('button', { name: 'Short' })).toHaveAttribute('aria-pressed', 'true')
      await clear('Reply length')

      await expect(panel.getByRole('switch', { name: 'Send a sticker with replies' })).toBeVisible()
      await expect(panel.getByRole('switch', { name: 'Say which tools a reply used, and its sources' })).toBeVisible()
      await expect(panel.getByText('Footer emoji', { exact: true })).toBeVisible()
      await panel.getByRole('button', { name: '✨' }).click()
      await clear('Footer emoji')

      // Group-only controls are present on a group chat.
      await expect(panel.getByRole('switch', { name: 'Answer any message in this group' })).toBeVisible()
      const nameCall = panel.getByRole('switch', { name: "Answer a message that says the character's name" })
      await expect(nameCall).toBeVisible()
      await nameCall.click()
      const addName = panel.getByLabel('Add a name')
      await addName.fill('Fieldbot')
      await addName.press('Enter')
      await expect(panel.getByText('Fieldbot', { exact: true })).toBeVisible()
      await panel.getByRole('button', { name: 'Remove Fieldbot' }).click()
      await expect(panel.getByText('Fieldbot', { exact: true })).toHaveCount(0)
      await clear('Name call')

      await expect(panel.getByRole('switch', { name: 'Replay earlier messages as context' })).toBeVisible()
      const contextSize = panel.getByLabel('Context size')
      await expect(contextSize).toHaveValue('40')
      await contextSize.fill('42')
      await contextSize.press('Enter')
      await expect(panel.getByLabel('Context size')).toHaveValue('42')
      await clear('Context size')
      await expect(panel.getByLabel('Context size')).toHaveValue('40')

      await expect(panel.getByRole('switch', { name: 'Learn and recall facts in this chat' })).toBeVisible()
      await expect(panel.getByLabel('Memory page')).toHaveValue('25')
      const reactions = panel.getByRole('switch', { name: "React to members' messages with an emoji" })
      await expect(reactions).toBeVisible()
      await reactions.click()
      await expect(panel.getByText('Chance', { exact: true })).toBeVisible()
      await panel.getByRole('button', { name: '50%' }).click()
      await expect(panel.getByRole('button', { name: '50%' })).toHaveAttribute('aria-pressed', 'true')
      await clear('Chance')
      await clear('Reactions')
      await expect(panel.getByText('Chance', { exact: true })).toHaveCount(0)

      const toolsRow = panel.getByText('Tools per message', { exact: true }).locator('xpath=../..')
      await expect(toolsRow.getByRole('button', { name: '3' })).toBeVisible()
      await toolsRow.getByRole('button', { name: '5' }).click()
      await expect(toolsRow.getByRole('button', { name: '5' })).toHaveAttribute('aria-pressed', 'true')
      await clear('Tools per message')
      await expect(toolsRow.getByRole('button', { name: '3' })).toHaveAttribute('aria-pressed', 'true')
      const commandsRow = rowHeader('Commands per message').locator('xpath=..')
      await expect(commandsRow.getByRole('button', { name: '1', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(panel.getByRole('group', { name: 'footer emoji', exact: true })).toBeVisible()

      // Refresh restores the visible inheritance, not a stale draft.
      await page.goto(settingsUrl)
      await tab('Reply').click()
      await expect(panel.getByLabel('Context size')).toHaveValue('40')

      // Features tab: all fifteen toggles inventoried, one changed and cleared.
      await tab('Features').click()
      const features = [
        'Reminders',
        'Web search',
        'Social posts',
        'Photos',
        'Media watching',
        'Deeper thinking',
        'Feedback',
        'Image identification',
        'Research',
        'Reports',
        'Messages first',
        'Voice notes',
        'Post media',
        'Lessons',
        'Owner tools'
      ]
      for (const name of features) {
        await expect(panel.getByRole('switch', { name }).first()).toBeVisible()
      }
      await panel.getByRole('switch', { name: 'Reminders' }).click()
      await clear('Reminders')
      // Reports owns the default document format row while it stays on.
      await expect(panel.getByText('Default document format', { exact: true })).toBeVisible()
      await panel.getByRole('button', { name: 'Markdown' }).click()
      await clear('Default document format')
      // A loaded catalog supplies the nested platform groups.
      await expect(panel.getByRole('group', { name: 'Social post platforms' })).toBeVisible()
      await expect(panel.getByRole('group', { name: 'Post media platforms' })).toBeVisible()

      await tab('Quiet hours').click()
      await expect(panel.getByText('Quiet hours', { exact: true })).toBeVisible()
      const startTime = panel.getByLabel('From', { exact: true })
      const endTime = panel.getByLabel('Until', { exact: true })
      await startTime.fill('22:00')
      await endTime.fill('06:00')
      const zone = panel.getByLabel('Time zone', { exact: true })
      await zone.fill('UTC')
      await panel.getByRole('button', { name: 'Save quiet hours' }).click()
      await expect(startTime).toHaveValue('22:00')
      await expect(endTime).toHaveValue('06:00')
      await expect(zone).toHaveValue('UTC')
      await clear('Quiet period')
      await expect(startTime).toHaveValue('23:00')
      await expect(endTime).toHaveValue('07:00')
      await expect(zone).toHaveValue('Asia/Kuala_Lumpur')

      // Access tab: sender access is editable, mute and model are read-only.
      await tab('Access').click()
      await panel.getByRole('button', { name: 'Edit who may write' }).click()
      await panel.getByRole('radio', { name: 'Only listed senders' }).click()
      const senderInput = panel.getByLabel('Add a sender id')
      await senderInput.fill('sender-1')
      await panel.getByRole('button', { name: 'Add', exact: true }).click()
      await expect(panel.getByText('sender-1', { exact: true })).toBeVisible()
      await panel.getByRole('button', { name: 'Review' }).click()
      const [accessSave] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === 'PUT' && new URL(response.url()).pathname === '/owner-api/core/settings'
        ),
        panel.getByRole('button', { name: 'Confirm save', exact: true }).click()
      ])
      expect(accessSave.status(), await accessSave.text()).toBe(200)
      await expect(panel.getByRole('button', { name: 'Edit who may write', exact: true })).toBeVisible()
      await expect(rowHeader('Who may write').getByText('set here', { exact: true })).toBeVisible()
      await expect(panel.getByText('Set here', { exact: true })).toBeVisible()
      await expect(panel.getByText(/Only 1 listed sender in this group may write/)).toBeVisible()
      const blocked = await gateway.send({
        chat: { waId: GROUP_WAID, kind: 'group' },
        sender: MEMBER,
        mid: 'fixture-fields-blocked',
        text: 'this sender is outside the test list'
      })
      expect(blocked.content).toBe('NO_REPLY')
      expect(model.requests).toHaveLength(0)
      await panel.getByRole('button', { name: 'Edit who may write' }).click()
      await panel.getByRole('button', { name: 'Use inherited' }).click()
      await panel.getByRole('button', { name: 'Clear to inherited' }).click()
      await expect(panel.getByText('Inherited', { exact: true })).toBeVisible()
      await expect(panel.getByText(/Everyone in this group may write/)).toBeVisible()
      const mutedRow = panel.getByText('Muted', { exact: true }).locator('xpath=../..')
      await expect(mutedRow.getByText('Not muted.')).toBeVisible()
      await expect(mutedRow.getByRole('switch')).toHaveCount(0)
      await expect(mutedRow.getByRole('textbox')).toHaveCount(0)
      const modelRow = panel.getByText('Model', { exact: true }).locator('xpath=../..')
      await expect(modelRow.getByText('The deployment’s main model.')).toBeVisible()
      await expect(modelRow.getByRole('switch')).toHaveCount(0)
      await expect(modelRow.getByRole('textbox')).toHaveCount(0)

      // Clearing sender access admits the same sender on the next turn.
      const delivery = await gateway.send({
        chat: { waId: GROUP_WAID, kind: 'group' },
        sender: MEMBER,
        mid: 'fixture-fields-mid-1',
        text: 'hello from the chat settings fields test'
      })
      expect(delivery.status).toBe('delivered')
      expect(delivery.content).toContain('Fixture fields happy path reply')
      const turn = app.storage.read(
        (db) =>
          db.prepare('SELECT chat_id FROM turn ORDER BY received_at DESC, rowid DESC LIMIT 1').get() as {
            chat_id: string
          }
      )
      expect(turn.chat_id).toBe(chat.chatId)

      // Group-only reply controls are omitted on a direct chat.
      await page.goto(origin + '/app/preview/chats/' + encodeURIComponent(dm.chatId) + '/settings')
      await tab('Reply').click()
      await expect(panel.getByText('Free response', { exact: true })).toHaveCount(0)
      await expect(panel.getByText('Name call', { exact: true })).toHaveCount(0)

      // Group defaults override global and clearing the group reveals global.
      await page.goto(origin + '/app/preview/chats/defaults')
      await expect(page.getByRole('heading', { name: 'Chat Defaults', exact: true })).toBeVisible()
      await expect(
        page.getByText('Name-call names, per-platform switches, sender access, mute and model stay on')
      ).toBeVisible()
      const defaultsSection = page.getByRole('region', { name: 'Chat defaults' })
      const defaultsLanguage = defaultsSection.getByLabel('language code')
      const scope = page.getByRole('complementary', { name: 'Defaults level' })
      const defaultsLanguageHeader = defaultsSection.getByText('Language', { exact: true }).locator('xpath=..')
      const setDefaultLanguage = async (value: string) => {
        await defaultsLanguage.fill(value)
        await defaultsSection.getByRole('button', { name: 'Save language', exact: true }).click()
        await expect(defaultsLanguageHeader.getByRole('button', { name: 'Use inherited', exact: true })).toBeVisible()
      }
      await expect(scope.getByRole('button', { name: 'Global', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await setDefaultLanguage('en')
      await scope.getByRole('button', { name: 'Group defaults', exact: true }).click()
      await expect(defaultsLanguage).toHaveValue('en')
      await expect(defaultsLanguageHeader.getByRole('button', { name: 'Use inherited', exact: true })).toHaveCount(0)
      await setDefaultLanguage('ms')

      await page.goto(settingsUrl)
      await expect(rowHeader('Language').getByText('from group defaults', { exact: true })).toBeVisible()
      await expect(panel.getByLabel('language code')).toHaveValue('ms')

      await page.goto(origin + '/app/preview/chats/defaults')
      await expect(defaultsLanguage).toHaveValue('en')
      const allowResponse = Promise.withResolvers<void>()
      const isGroupDefaultsRead = (url: URL) =>
        url.origin === origin &&
        url.pathname === '/owner-api/core/settings' &&
        url.searchParams.get('level') === 'type' &&
        url.searchParams.get('scope') === 'group'
      await page.route(
        isGroupDefaultsRead,
        async (route) => {
          await allowResponse.promise
          await route.continue()
        },
        { times: 1 }
      )
      try {
        await Promise.all([
          page.waitForRequest((request) => isGroupDefaultsRead(new URL(request.url()))),
          scope.getByRole('button', { name: 'Group defaults', exact: true }).click()
        ])
        await expect(defaultsLanguage).toHaveCount(0)
      } finally {
        allowResponse.resolve()
      }
      await expect(defaultsLanguage).toHaveValue('ms')
      await defaultsLanguageHeader.getByRole('button', { name: 'Use inherited', exact: true }).click()
      await expect(defaultsLanguage).toHaveValue('en')
      await expect(defaultsLanguageHeader.getByRole('button', { name: 'Use inherited', exact: true })).toHaveCount(0)

      await page.goto(settingsUrl)
      await expect(rowHeader('Language').getByText('from global', { exact: true })).toBeVisible()
      await expect(panel.getByLabel('language code')).toHaveValue('en')

      await ctx.close()
      expect(faults).toEqual([])
    } finally {
      await browser.close()
    }
  } finally {
    host.closeAllConnections()
    await new Promise<void>((done) => host.close(() => done()))
  }
})
