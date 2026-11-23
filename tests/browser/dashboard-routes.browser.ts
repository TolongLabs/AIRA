import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { expect } from 'playwright/test'
import { it } from 'vitest'
import { queueModel, startApp } from '../support/app.js'

// Bounded Chromium journey over the dashboard routes (AIRA #369/370/371).
// Real production build (site/dist) through tests/support/app, loopback fake
// owner host, temp data dir per case, synthetic fixture targets. Chromium only,
// one focused case per area, no fake success: every assertion names an
// observable result. Failures fail; nothing is skipped.

const TOKEN = 'fixture-routes-token'
const ITEM_ID = 'vocab:架空/test'
const ENCODED_ITEM = encodeURIComponent(ITEM_ID)

function pathnameOf(url?: string): string {
  return (url ?? '/').split('?')[0] ?? '/'
}

function searchOf(url?: string): URLSearchParams {
  return new URLSearchParams((url ?? '').split('?')[1] ?? '')
}

async function readJson(request: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  return JSON.parse(raw) as unknown
}

function json(response: import('node:http').ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
}

interface FixtureState {
  failSettings: boolean
  failDashboard: boolean
  failCron: boolean
  failItemOnce: boolean
  failItemAlways: boolean
  settings: {
    bindings: Record<string, unknown>
    markets: {
      watchlist: string[]
      alerts: { symbol: string; direction: string; level: number }[]
      default_target: string
      news_digest: { enabled: boolean; to: string[] }
    }
    tts: { enabled: boolean }
    models: Record<string, unknown>
    regions: { value: string; label: string }[]
  }
  dashboard: Record<string, unknown>
  cron: { jobs: Record<string, unknown>[]; archive: unknown[] }
  chats: { chats: Record<string, unknown>[] }
  notices: {
    sessions: Record<string, unknown>[]
    routes: Record<string, unknown>[]
    machines: Record<string, unknown>[]
    targets: Record<string, unknown>[]
    quiet: unknown[]
  }
  libIndex: Record<string, unknown>
  libDetails: Record<string, Record<string, unknown>>
  graph: Record<string, unknown>
}

function baseState(): FixtureState {
  const now = Math.floor(Date.now() / 1000)
  return {
    failSettings: false,
    failDashboard: false,
    failCron: false,
    failItemOnce: false,
    failItemAlways: false,
    settings: {
      bindings: {},
      markets: {
        watchlist: ['spx'],
        alerts: [{ symbol: 'spx', direction: 'below', level: 6000 }],
        default_target: 'whatsapp:fixture-group@g.us',
        news_digest: { enabled: false, to: [] }
      },
      tts: { enabled: false },
      models: {},
      regions: [{ value: 'sg', label: 'Singapore' }]
    },
    dashboard: {
      brain: { note: 1 },
      services: { Core: 'active', Gateway: 'active', 'Owner Service': 'active', Scheduler: 'active' },
      recent: [],
      markets: {
        quotes: {
          spx: { price: 6000.5, change_pct: 0.85, currency: 'USD', name: 'S&P 500', exchange: 'NASDAQ' }
        },
        news: {
          spx: {
            ts: now,
            items: [
              {
                title: 'Fixture market story',
                link: 'https://example.test/story',
                source: 'Fixture Wire',
                published: 'Mon, 16 Nov 2026 10:00:00 GMT',
                ts: now - 60
              }
            ]
          }
        }
      }
    },
    cron: {
      jobs: [
        {
          job_id: 'aira:fixture-owned',
          name: 'Fixture owned',
          schedule: '30 8 * * *',
          enabled: true,
          state: 'scheduled',
          next_run_at: '2026-12-01T08:30:00.000Z',
          prompt: '[AIRA-SCHEDULED v1 kind=other] owned routine',
          prompt_preview: 'owned routine',
          deliver: 'local',
          last_status: 'ok'
        },
        {
          job_id: 'fixture-morning',
          name: 'Morning check',
          schedule: '30 8 * * *',
          enabled: true,
          state: 'scheduled',
          next_run_at: '2026-12-01T08:30:00.000Z',
          prompt: 'Ask him how he slept',
          prompt_preview: 'Ask him how he slept',
          deliver: 'whatsapp:fixture-group@g.us',
          origin: { platform: 'whatsapp', chat_id: 'fixture-group@g.us', chat_name: 'Field Notes' }
        }
      ],
      archive: []
    },
    chats: {
      chats: [
        {
          target: 'whatsapp:fixture-group@g.us',
          jid: 'fixture-group@g.us',
          label: 'Field Notes',
          name: 'Field Notes',
          kind: 'group'
        }
      ]
    },
    notices: {
      sessions: [
        {
          project: 'fixture-proj',
          branch: 'main',
          model: 'fixture-model',
          entrypoint: 'cli',
          turns: 12,
          idle_seconds: 5,
          active: true,
          tools: ['read']
        }
      ],
      routes: [
        {
          machine: 'fixture-machine',
          target: 'whatsapp:fixture-dm@s.whatsapp.net',
          label: 'Field Notes',
          enabled: true,
          mode: 'summary',
          when: 'every_turn',
          quote_prompt: false
        }
      ],
      machines: [{ machine: 'fixture-machine', last_seen: now - 30, routed: true }],
      targets: [{ jid: 'fixture-dm@s.whatsapp.net', label: 'Field Notes', kind: 'dm' }],
      quiet: []
    },
    libIndex: {
      counts: { vocab: 1, song: 1 },
      items: {
        vocab: [
          {
            id: ITEM_ID,
            type: 'vocab',
            title: '架空',
            sub: 'fiction · fantasy',
            owner: 'shared library',
            links: 1,
            reviewed: false,
            when: '2026-11-20'
          }
        ],
        song: [
          {
            id: 'song:lemon',
            type: 'song',
            title: 'Lemon',
            sub: 'a fixture song',
            owner: 'shared library',
            links: 1,
            when: '2026-11-19'
          }
        ]
      },
      types: ['vocab', 'song'],
      edges: 1
    },
    libDetails: {
      [ITEM_ID]: {
        item: {
          id: ITEM_ID,
          type: 'vocab',
          title: '架空',
          data: {
            gloss_en: 'fiction; fantasy',
            explanation: 'A fixture gloss for the routes test.',
            pos: 'noun'
          }
        },
        links: [{ id: 'song:lemon', type: 'song', title: 'Lemon', sub: 'a fixture song', rel: 'example', out: true }],
        prev: null,
        next: null,
        position: { at: 1, of: 1 }
      },
      ['song:lemon']: {
        item: { id: 'song:lemon', type: 'song', title: 'Lemon', data: {} },
        links: [{ id: ITEM_ID, type: 'vocab', title: '架空', sub: 'fiction · fantasy', rel: 'example', out: false }],
        prev: null,
        next: null,
        position: { at: 1, of: 1 }
      }
    },
    graph: {
      nodes: [
        { id: ITEM_ID, type: 'vocab', label: '架空', url: ITEM_ID },
        { id: 'song:lemon', type: 'song', label: 'Lemon', url: 'song:lemon' }
      ],
      edges: [{ s: ITEM_ID, t: 'song:lemon', r: 'example' }],
      counts: { vocab: 1, song: 1 }
    }
  }
}

async function startFixture(state: FixtureState): Promise<{ origin: string; close: () => Promise<void> }> {
  const host = createServer((request, response) => {
    void (async () => {
      if (request.headers['x-tolongai-token'] !== TOKEN) {
        json(response, 401, { error: 'Owner token required' })
        return
      }
      const path = pathnameOf(request.url)
      const query = searchOf(request.url)
      if (request.method === 'GET' && path === '/api/settings') {
        if (state.failSettings) {
          json(response, 500, { error: 'settings down' })
          return
        }
        json(response, 200, state.settings)
        return
      }
      if (request.method === 'GET' && path === '/api/dashboard') {
        if (state.failDashboard) {
          json(response, 500, { error: 'dashboard down' })
          return
        }
        json(response, 200, state.dashboard)
        return
      }
      if (request.method === 'GET' && path === '/api/cron') {
        if (state.failCron) {
          json(response, 500, { error: 'cron down' })
          return
        }
        json(response, 200, state.cron)
        return
      }
      if (request.method === 'GET' && path === '/api/chats') {
        json(response, 200, state.chats)
        return
      }
      if (request.method === 'GET' && path === '/api/notices') {
        json(response, 200, state.notices)
        return
      }
      if (request.method === 'GET' && path === '/api/graph') {
        json(response, 200, state.graph)
        return
      }
      if (request.method === 'GET' && path === '/api/library/index') {
        json(response, 200, state.libIndex)
        return
      }
      if (request.method === 'GET' && path === '/api/library/item') {
        if (state.failItemAlways || state.failItemOnce) {
          state.failItemOnce = false
          json(response, 500, { error: 'library item down' })
          return
        }
        const id = query.get('id') ?? ''
        const detail = state.libDetails[id]
        if (!detail) {
          json(response, 404, { error: 'not_found' })
          return
        }
        json(response, 200, detail)
        return
      }
      if (request.method === 'GET' && path === '/api/market/history') {
        const symbol = (query.get('symbol') ?? 'spx').toLowerCase()
        json(response, 200, {
          symbol,
          span: query.get('span') ?? '1m',
          points: [
            [1760000000, 5900],
            [1760086400, 6000.5]
          ],
          currency: 'USD',
          name: symbol === 'spx' ? 'S&P 500' : symbol.toUpperCase(),
          price: 6000.5
        })
        return
      }
      if (request.method === 'POST' && path === '/api/settings/markets') {
        const body = (await readJson(request)) as Record<string, unknown>
        const markets = state.settings.markets
        if (Array.isArray(body['watchlist'])) markets.watchlist = (body['watchlist'] as unknown[]).map(String)
        if (Array.isArray(body['alerts']))
          markets.alerts = (body['alerts'] as Record<string, unknown>[]).map((row) => ({
            symbol: String(row['symbol'] ?? ''),
            direction: String(row['direction'] ?? 'below'),
            level: Number(row['level'] ?? 0)
          }))
        if (typeof body['default_target'] === 'string') markets.default_target = body['default_target']
        json(response, 200, { markets: { watchlist: markets.watchlist, alerts: markets.alerts } })
        return
      }
      if (request.method === 'POST' && path === '/api/settings/notice_route') {
        const body = (await readJson(request)) as Record<string, unknown>
        const machine = String(body['machine'] ?? '')
        const target = String(body['target'] ?? '')
        const row = state.notices.routes.find(
          (candidate) => candidate['machine'] === machine && candidate['target'] === target
        )
        if (body['remove']) {
          state.notices.routes = state.notices.routes.filter((candidate) => candidate !== row)
          json(response, 200, {})
          return
        }
        if (!row) {
          state.notices.routes.push({
            machine,
            target,
            label: typeof body['label'] === 'string' ? body['label'] : '',
            enabled: false,
            mode: 'summary',
            when: 'every_turn',
            quote_prompt: false
          })
          json(response, 200, {})
          return
        }
        for (const key of ['enabled', 'label', 'quote_prompt', 'when', 'mode'] as const) {
          if (body[key] !== undefined) row[key] = body[key]
        }
        json(response, 200, {})
        return
      }
      if (request.method === 'POST' && path === '/api/settings/quiet_release') {
        json(response, 200, { routes_restored: [] })
        return
      }
      if (request.method === 'POST' && (path === '/api/market/quote' || path === '/api/market/news')) {
        json(response, 200, path.endsWith('quote') ? { quotes: {} } : { items: [] })
        return
      }
      json(response, 404, { error: 'not_found' })
    })().catch(() => {
      try {
        json(response, 500, { error: 'host_error' })
      } catch {
        // closed
      }
    })
  })
  await new Promise<void>((done) => host.listen(0, '127.0.0.1', done))
  const address = host.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener')
  const { app } = await startApp(queueModel([]), {
    env: { AIRA_OWNER_API_ORIGIN: 'http://127.0.0.1:' + address.port },
    siteDir: resolve('site/dist')
  })
  const site = await app.listenSite(0, '127.0.0.1')
  const origin = 'http://127.0.0.1:' + site.port
  return {
    origin,
    close: async () => {
      host.closeAllConnections()
      await new Promise<void>((done) => host.close(() => done()))
    }
  }
}

async function auth(page: import('playwright').Page, origin: string): Promise<void> {
  await page.goto(origin + '/app/preview/overview')
  await page.getByPlaceholder('site token').fill(TOKEN)
  await page.getByRole('button', { name: 'Save token' }).click()
  await page.getByRole('heading', { name: 'Overview' }).waitFor()
}

it('library opaque id opens, graph focuses it, and a refused item recovers on retry', async () => {
  const state = baseState()
  const fixture = await startFixture(state)
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    await page.route('**/*', (route) =>
      new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort()
    )
    const faults: string[] = []
    page.on('pageerror', (error) => faults.push(error.message))
    await auth(page, fixture.origin)

    // Cold deep link with an opaque id: colon, unicode and an encoded slash stay one segment.
    await page.goto(fixture.origin + '/app/preview/library/item/' + ENCODED_ITEM)
    await expect(page.getByRole('heading', { name: '架空' }).first()).toBeVisible()
    await expect(page.getByText('fiction; fantasy')).toBeVisible()
    const connections = page.getByRole('link', { name: 'View Connections' })
    await expect(connections).toBeVisible()
    expect(await connections.getAttribute('href')).toContain('focus=vocab')

    // Graph focuses the same entry from the cold link and offers the way back.
    await page.goto(fixture.origin + '/app/preview/library/graph?focus=' + ENCODED_ITEM)
    await expect(page.getByRole('heading', { name: '架空' })).toBeVisible()
    const openInLibrary = page.getByRole('link', { name: /open in the library/ })
    await expect(openInLibrary).toBeVisible()
    expect(await openInLibrary.getAttribute('href')).toContain(ENCODED_ITEM.split('%2F')[0] ?? 'vocab')

    // Refusal shows recovery UI, and a retry after the host recovers renders the entry.
    state.failItemOnce = true
    await page.goto(fixture.origin + '/app/preview/library/item/' + ENCODED_ITEM)
    await expect(page.getByRole('heading', { name: 'Could not load this entry' })).toBeVisible()
    await page.getByRole('button', { name: 'Retry' }).click()
    await expect(page.getByRole('heading', { name: '架空' }).first()).toBeVisible()

    expect(faults).toEqual([])
    await context.close()
  } finally {
    await browser.close()
    await fixture.close()
  }
})

it('markets cold tabs render fixtures and an unavailable settings source offers retry', async () => {
  const state = baseState()
  const fixture = await startFixture(state)
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    await page.route('**/*', (route) =>
      new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort()
    )
    const faults: string[] = []
    page.on('pageerror', (error) => faults.push(error.message))
    await auth(page, fixture.origin)

    await page.goto(fixture.origin + '/app/preview/markets/watchlist')
    await expect(page.getByRole('link', { name: 'Watchlist' })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('listbox', { name: 'Followed instruments' })).toBeVisible()
    await expect(page.getByRole('option', { name: /SPX/ }).first()).toBeVisible()

    await page.goto(fixture.origin + '/app/preview/markets/alerts')
    await expect(page.getByRole('link', { name: 'Alerts and Delivery' })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('heading', { name: 'Armed alerts' })).toBeVisible()
    await expect(page.getByText('goes below')).toBeVisible()

    await page.goto(fixture.origin + '/app/preview/markets/news')
    await expect(page.getByRole('link', { name: 'News' })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByText('Fixture market story')).toBeVisible()

    state.failSettings = true
    await page.goto(fixture.origin + '/app/preview/markets/alerts')
    await expect(page.getByText(/Alerts unavailable/)).toBeVisible()
    state.failSettings = false
    await page.getByRole('button', { name: 'Retry' }).first().click()
    await expect(page.getByText('goes below')).toBeVisible()

    expect(faults).toEqual([])
    await context.close()
  } finally {
    await browser.close()
    await fixture.close()
  }
})

it('automations shows a managed routine read-only, and missing/failed lookups recover', async () => {
  const state = baseState()
  const fixture = await startFixture(state)
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    await page.route('**/*', (route) =>
      new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort()
    )
    const faults: string[] = []
    page.on('pageerror', (error) => faults.push(error.message))
    await auth(page, fixture.origin)

    await page.goto(fixture.origin + '/app/preview/automations/routines')
    await expect(page.getByRole('link', { name: /Morning check/ }).first()).toBeVisible()
    await expect(page.getByRole('link', { name: /Fixture owned/ }).first()).toBeVisible()

    const ownedId = encodeURIComponent('aira:fixture-owned')
    await page.goto(fixture.origin + '/app/preview/automations/routines/' + ownedId)
    const detail = page.locator('.automations-detail')
    await expect(detail.getByText('Managed by AIRA')).toBeVisible()
    await expect(detail.getByText('owned routine', { exact: true })).toBeVisible()
    await expect(detail.getByRole('button', { name: 'edit' })).toHaveCount(0)

    await page.goto(fixture.origin + '/app/preview/automations/routines/fixture-morning')
    await expect(detail.locator('.automations-detail-prompt')).toHaveText('Ask him how he slept')
    await expect(detail.getByText(/goes to Field Notes/)).toBeVisible()

    await page.goto(fixture.origin + '/app/preview/automations/routines/no-such-job')
    await expect(page.getByText('This routine is gone')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Back to routines' }).first()).toBeVisible()

    state.failCron = true
    await page.goto(fixture.origin + '/app/preview/automations/routines/fixture-morning')
    await expect(page.getByText('Routine unavailable')).toBeVisible()
    state.failCron = false
    await page.getByRole('button', { name: 'Retry' }).first().click()
    await expect(detail.locator('.automations-detail-prompt')).toHaveText('Ask him how he slept')

    expect(faults).toEqual([])
    await context.close()
  } finally {
    await browser.close()
    await fixture.close()
  }
})

it('notices quote control persists and reads back the saved route', async () => {
  const state = baseState()
  const fixture = await startFixture(state)
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    await page.route('**/*', (route) =>
      new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort()
    )
    const faults: string[] = []
    page.on('pageerror', (error) => faults.push(error.message))
    await auth(page, fixture.origin)

    await page.goto(fixture.origin + '/app/preview/automations/notices')
    await expect(page.getByText('fixture-proj')).toBeVisible()
    await expect(page.getByText('Field Notes').first()).toBeVisible()
    const quote = page.getByRole('switch', { name: 'quote what was asked' })
    await expect(quote).toBeVisible()
    await expect(quote).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByText('off — only what finished, never what was asked')).toBeVisible()

    await quote.click()
    await expect(page.getByText('the line that started the session is included')).toBeVisible()
    await expect(quote).toHaveAttribute('aria-checked', 'true')

    await page.reload()
    await expect(page.getByRole('switch', { name: 'quote what was asked' })).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByText('the line that started the session is included')).toBeVisible()

    const res = await fetch(fixture.origin + '/owner-api/notices', {
      headers: { 'x-tolongai-token': TOKEN }
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { routes: { quote_prompt: boolean }[] }
    expect(body.routes[0]?.quote_prompt).toBe(true)

    expect(faults).toEqual([])
    await context.close()
  } finally {
    await browser.close()
    await fixture.close()
  }
})

it('system health and appearance open on direct paths and appearance persists', async () => {
  const state = baseState()
  const fixture = await startFixture(state)
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    await page.route('**/*', (route) =>
      new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort()
    )
    const faults: string[] = []
    page.on('pageerror', (error) => faults.push(error.message))
    await auth(page, fixture.origin)

    await page.goto(fixture.origin + '/app/preview/system/health')
    await expect(page.getByRole('heading', { name: 'Service Health' })).toBeVisible()
    await expect(page.getByText('Core')).toBeVisible()
    await expect(page.getByText('Gateway')).toBeVisible()
    await expect(page.getByText('active').first()).toBeVisible()

    await page.goto(fixture.origin + '/app/preview/system/appearance')
    await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible()
    const lattice = page.getByRole('radio', { name: /Lattice/ })
    await expect(lattice).toBeVisible()
    await lattice.check()
    await expect(page.locator('.dashboard-backdrop--lattice')).toBeVisible()
    await page.getByRole('button', { name: 'Apply', exact: true }).click()
    await page.reload()
    await expect(page.locator('.dashboard-backdrop--lattice')).toBeVisible()
    await expect(page.getByRole('radio', { name: /Lattice/ })).toBeChecked()

    expect(faults).toEqual([])
    await context.close()
  } finally {
    await browser.close()
    await fixture.close()
  }
})
