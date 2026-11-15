import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDiskGuard } from '../../src/storage/disk-guard.js'
import { FakeGateway, type GatewayMessage } from '../harness/gateway.js'
import { startTestCore } from '../support/core.js'

const CHAT = 'test-chat-diskfull'
const ALICE = 'test-member-alice'

const msg = (mid: string, text: string): GatewayMessage => ({
  chat: { waId: CHAT, kind: 'group' },
  sender: ALICE,
  mid,
  text
})

describe('disk full suite', () => {
  it('writes nothing half-applied while full, keeps responding, and recovers when space returns', async () => {
    const core = await startTestCore()
    core.activate(CHAT)

    expect((await core.gateway.send(msg('m-1', 'first'))).status).toBe('delivered')
    expect((await core.gateway.send(msg('m-2', 'second'))).status).toBe('delivered')

    // Fill the volume by capping SQLite's page count at its current size and padding until a write throws.
    core.storage.tx((db) => {
      const pages = db.pragma('page_count', { simple: true }) as number
      db.pragma(`max_page_count = ${pages}`)
    })

    const padding = 'x'.repeat(2000)
    let full = false
    for (let i = 0; i < 500; i++) {
      try {
        core.storage.tx((db) => {
          db.prepare(
            "INSERT INTO session_message (chat_id, role, content, created_at) VALUES ('filler', 'user', ?, ?)"
          ).run(padding, new Date().toISOString())
        })
      } catch {
        full = true
        break
      }
    }
    // The suite proves nothing unless a write really was refused.
    expect(full).toBe(true)

    const gw = new FakeGateway({ baseUrl: core.baseUrl, attempts: 2 })
    const failedMids: string[] = []
    for (const mid of ['m-full-1', 'm-full-2', 'm-full-3']) {
      const delivery = await gw.send(msg(mid, `during full ${mid}`))
      expect(['delivered', 'failed']).toContain(delivery.status)
      if (delivery.status === 'failed') failedMids.push(mid)
    }

    // While still full: integrity and invariants hold.
    core.storage.check()

    const badDelivered = core.storage.read(
      (db) =>
        db
          .prepare(
            `SELECT t.turn_id FROM turn t
             WHERE t.state = 'delivered'
               AND (SELECT count(*) FROM session_message s WHERE s.turn_id = t.turn_id AND s.role = 'assistant') <> 1`
          )
          .all() as unknown[]
    )
    expect(badDelivered).toEqual([])

    const orphanReplies = core.storage.read(
      (db) =>
        db
          .prepare(
            `SELECT s.id FROM session_message s
             JOIN turn t ON t.turn_id = s.turn_id
             WHERE s.role = 'assistant' AND t.state NOT IN ('delivered', 'failed')`
          )
          .all() as unknown[]
    )
    expect(orphanReplies).toEqual([])

    const unansweredMarked = core.storage.read(
      (db) =>
        db
          .prepare(
            `SELECT i.mid FROM inbound_message i
             WHERE i.state = 'answered'
               AND NOT EXISTS (
                 SELECT 1 FROM session_message s
                 WHERE s.turn_id = i.turn_id AND s.role = 'assistant'
               )`
          )
          .all() as unknown[]
    )
    expect(unansweredMarked).toEqual([])

    // Free space and verify normal replies and retry of a failed message.
    core.storage.tx((db) => {
      const pages = db.pragma('page_count', { simple: true }) as number
      db.pragma(`max_page_count = ${pages + 2000}`)
    })

    const after = await gw.send(msg('m-after', 'space is back'))
    expect(after.status).toBe('delivered')
    expect(after.content).toMatch(/^scripted reply /)

    if (failedMids[0] !== undefined) {
      const retried = await gw.send(msg(failedMids[0], 'retry failed'))
      expect(retried.status).toBe('delivered')
      expect(retried.content).toMatch(/^scripted reply /)
    }
  })

  it('empties cache and pauses archive and memory extraction under disk guard while still replying', async () => {
    const core = await startTestCore()
    core.activate(CHAT)

    const cacheDir = join(core.dataDir, 'cache')
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(join(cacheDir, 'cached.bin'), 'stale-data')

    let freeMb = core.config.storage.minFreeMb + 100
    const guard = createDiskGuard({
      dataDir: core.dataDir,
      minFreeMb: core.config.storage.minFreeMb,
      criticalFreeMb: core.config.storage.criticalFreeMb,
      storage: core.storage,
      freeMb: () => freeMb
    })

    // Warn level: under minFreeMb.
    freeMb = core.config.storage.minFreeMb - 1
    const warn = guard.check()
    expect(warn.level).toBe('warn')
    expect(warn.paused.archive).toBe(true)
    expect(warn.paused.memoryExtraction).toBe(false)
    expect(readdirSync(cacheDir)).toEqual([])
    expect((await core.gateway.send(msg('m-warn', 'hello at warn'))).status).toBe('delivered')

    // Critical level: under criticalFreeMb.
    freeMb = core.config.storage.criticalFreeMb - 1
    const critical = guard.check()
    expect(critical.level).toBe('critical')
    expect(critical.paused.archive).toBe(true)
    expect(critical.paused.memoryExtraction).toBe(true)
    expect((await core.gateway.send(msg('m-crit', 'hello at critical'))).status).toBe('delivered')
  })
})
