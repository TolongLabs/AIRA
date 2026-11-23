import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { queueModel, startApp } from '../support/app.js'
import { tmpDir } from '../support/tmp.js'

it('switches the private entry with one flag, keeps old queries and protects both API surfaces', async () => {
  const siteDir = tmpDir('aira-dashboard-entry-')
  mkdirSync(join(siteDir, 'assets'), { recursive: true })
  writeFileSync(join(siteDir, 'preview.html'), '<!doctype html><title>Dashboard fixture</title>')
  writeFileSync(join(siteDir, 'index.html'), '<!doctype html><title>Old fixture</title>')
  const { app } = await startApp(queueModel([]), { siteDir, env: { AIRA_DASHBOARD_ENTRY: 'dashboard' } })
  const site = await app.listenSite(0, '127.0.0.1')
  const origin = 'http://127.0.0.1:' + site.port
  for (const route of [
    '/overview',
    '/chats',
    '/characters',
    '/library',
    '/markets',
    '/automations',
    '/system',
    '/library/item/' + encodeURIComponent('vocab:架空/test'),
    '/automations/routines/aira%3Afixture'
  ]) {
    const res = await fetch(origin + route)
    expect(res.status, route).toBe(200)
    expect(await res.text()).toContain('Dashboard fixture')
  }
  const old = await fetch(origin + '/app/library.html?q=fixture', { redirect: 'manual' })
  expect(old.status).toBe(302)
  expect(old.headers.get('location')).toBe('/library?q=fixture')
  for (const route of ['/api/chats', '/owner-api/core/chats', '/owner-api/dashboard']) {
    const res = await fetch(origin + route)
    expect(res.status, route).toBe(401)
    expect(res.headers.get('cache-control')).toBe('no-store')
  }
  for (const route of [
    '/app/assets/missing.js',
    '/unknown',
    '/app/preview/missing',
    '/library/graph/missing',
    '/characters/%65xample/edit'
  ]) {
    const res = await fetch(origin + route)
    expect(res.status, route).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
  }
})
