import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AxeBuilder } from '@axe-core/playwright'
import { chromium } from 'playwright'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
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
    const gateway = await app.listen(0, '127.0.0.1')
    const site = await app.listenSite(port, '127.0.0.1')
    app.completeStartup()
    return { app, port: site.port, gatewayPort: gateway.port }
  }
  const cold = await boot()
  const origin = `http://127.0.0.1:${cold.port}`
  const token = readFileSync(join(root, 'standalone', 'owner.token'), 'utf8').trim()
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 810 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    async function capture(name: string) {
      const folder = process.env.AIRA_DASHBOARD_EVIDENCE_DIR
      if (!folder) return
      await mkdir(folder, { recursive: true })
      await page.screenshot({ path: resolve(folder, name + '.png'), animations: 'disabled' })
    }
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
    await capture('standalone-setup')
    await page.getByRole('link', { name: 'System Settings', exact: true }).click()
    const secret = 'synthetic-onboarding-key-canary'
    const mediaSecret = 'synthetic-onboarding-media-canary'
    await page.locator('#standalone-main-provider').fill('openai-compatible')
    await page.locator('#standalone-main-model').fill('fixture-model')
    await page.locator('#standalone-main-base').fill('http://127.0.0.1:12345/v1')
    await page.locator('#standalone-main-key').fill(secret)
    await page.getByRole('switch', { name: 'Use a media model' }).click()
    await page.locator('#standalone-media-model').fill('fixture-gemini-model')
    await page.locator('#standalone-media-key').fill(mediaSecret)
    await page.getByRole('button', { name: 'Save revision' }).click()
    await page.getByText('Saved, waiting to apply', { exact: true }).waitFor()
    expect(await page.locator('#standalone-main-key').inputValue()).toBe('')
    expect(await page.locator('#standalone-media-key').inputValue()).toBe('')
    expect(await page.content()).not.toContain(secret)
    expect(await page.content()).not.toContain(mediaSecret)
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(secret)
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(mediaSecret)
    await page.getByRole('button', { name: 'Apply saved revision' }).click()
    await expect.poll(() => restart.mock.calls.length).toBe(1)
    await cold.app.close()
    const applied = await boot(cold.port)
    await page.getByText('Running the saved revision.').waitFor()
    expect(await page.getByText('gemini · fixture-gemini-model · key saved', { exact: true }).count()).toBe(2)
    await capture('standalone-models')
    expect(model.requests).toHaveLength(0)
    await page.setViewportSize({ width: 320, height: 704 })
    expect(await page.locator('html').evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(320)
    const audit = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(audit.violations.map((row) => row.id)).toEqual([])
    await page.getByRole('switch', { name: 'Remove the saved media key on save' }).click()
    await page.getByRole('button', { name: 'Save revision' }).click()
    await page.getByText('gemini · fixture-gemini-model · no key', { exact: true }).waitFor()
    await page.getByRole('switch', { name: 'Use a media model' }).click()
    await page.getByRole('button', { name: 'Save revision' }).click()
    await page.getByText('gemini · fixture-gemini-model · no key', { exact: true }).waitFor({ state: 'hidden' })
    await page.goto(origin + '/app/preview/markets')
    await page.getByText(/capability_unavailable/).waitFor()
    await page.goto(origin + '/app/preview/characters')
    await page.getByText('Example', { exact: true }).first().waitFor()
    await page.goto(origin + '/app/preview/chats/defaults')
    await page.getByText(/Standalone supports text replies only/).waitFor()
    expect(await page.getByText('Send a sticker with replies', { exact: true }).count()).toBe(0)
    expect(await page.getByRole('switch', { name: 'Reports' }).count()).toBe(0)

    // Synthetic negotiation changes only the authenticated capability. No WhatsApp account or send is used.
    const gatewayToken = readFileSync(join(root, 'standalone', 'gateway.token'), 'utf8').trim()
    const gatewayPost = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${applied.gatewayPort}/v2/aira/${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${gatewayToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
    const attach = (capabilities: string[]) =>
      gatewayPost('attach-check', {
        schemaVersion: 2,
        adapterVersion: 'hermes-v0.23.4',
        profile: 'fixture',
        action: 'connect',
        capabilities,
        deadlineMs: Date.now() + 10_000
      })
    const documentRoute = await attach(['text', 'document'])
    expect(documentRoute.status).toBe(200)
    const routeId = z.object({ hermes: z.object({ routeId: z.uuid() }) }).parse(await documentRoute.json())
      .hermes.routeId
    await page.reload()
    await page.getByText(/Standalone supports text and report documents/).waitFor()
    await page.getByRole('switch', { name: 'Reports' }).waitFor()
    expect(await page.getByRole('switch', { name: 'Media watching' }).count()).toBe(0)
    await capture('standalone-report-defaults')
    await gatewayPost('turn', {
      schemaVersion: 2,
      routeId,
      profile: 'fixture',
      platform: 'whatsapp',
      kind: 'dm',
      chat: 'fixture-browser',
      sender: 'fixture-browser',
      mid: 'fixture-pending',
      text: 'hello'
    })
    const chatResponse = await fetch(origin + '/owner-api/core/chats', { headers: { 'x-tolongai-token': token } })
    const chats = z.object({ chats: z.array(z.object({ chatId: z.string() })) }).parse(await chatResponse.json()).chats
    expect(chats).toHaveLength(1)
    await page.goto(origin + '/app/preview/chats/' + chats[0]!.chatId + '/settings#features')
    await page.getByRole('switch', { name: 'Reports' }).waitFor()
    expect(await page.getByRole('switch', { name: 'Media watching' }).count()).toBe(0)
    expect(
      (await attach(['text', 'document', 'receive-image', 'receive-audio', 'receive-video', 'receive-pdf'])).status
    ).toBe(200)
    await page.reload()
    await page.getByRole('switch', { name: 'Media watching' }).waitFor()
    expect((await attach(['text'])).status).toBe(200)
    await page.reload()
    await page.getByRole('switch', { name: 'Reports' }).waitFor({ state: 'hidden' })
    await page.getByRole('switch', { name: 'Media watching' }).waitFor({ state: 'hidden' })
    // Emulate the exact older readback shape; the new UI must omit media on writes.
    let oldCoreWrites = 0
    await page.route('**/owner-api/core/standalone-config', async (route) => {
      if (route.request().method() === 'PUT') {
        expect(route.request().postDataJSON()).not.toHaveProperty('media')
        oldCoreWrites++
      }
      const response = await route.fetch()
      const body = await response.json()
      delete body.optionalRoles
      if (body.saved) delete body.saved.media
      if (body.applied) delete body.applied.media
      await route.fulfill({ response, json: body })
    })
    // Use the existing navigation destination, not a new view.
    await page.setViewportSize({ width: 1440, height: 810 })
    await page.goto(origin + '/app/preview/overview')
    await page.getByRole('link', { name: 'System Settings', exact: true }).click()
    await page.locator('#standalone-main-model').waitFor()
    expect(await page.getByRole('switch', { name: 'Use a media model' }).count()).toBe(0)
    await page.getByRole('button', { name: 'Save revision' }).click()
    await expect.poll(() => oldCoreWrites).toBe(1)
    await page.getByRole('button', { name: 'Save revision' }).waitFor()
    expect(model.requests).toHaveLength(0)
    expect(hostRequests).toEqual([])
    await applied.app.close()
  } finally {
    await browser.close()
    for (const app of apps) await app.close()
  }
})
