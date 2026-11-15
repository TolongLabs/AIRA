import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveSetting, setSetting } from '../../src/settings/settings.js'
import { takeSnapshot } from '../../src/storage/snapshot.js'
import type { GatewayMessage } from '../harness/gateway.js'
import { scriptedRunner, startTestCore } from '../support/core.js'
import { tmpDir } from '../support/tmp.js'

const CHAT = 'test-chat-restore'
const ALICE = 'test-member-alice'

const msg = (mid: string, text: string): GatewayMessage => ({
  chat: { waId: CHAT, kind: 'group' },
  sender: ALICE,
  mid,
  text
})

describe('restore suite', () => {
  it('restores a snapshot into a fresh folder with exact row counts, settings, window, and idempotency', async () => {
    const first = await startTestCore()
    const chatId = first.activate(CHAT)
    setSetting(first.storage, { level: 'chat', scope: chatId, key: 'character', value: 'example', actor: 'test' })

    expect((await first.gateway.send(msg('m-1', 'one'))).content).toBe('scripted reply 1')
    expect((await first.gateway.send(msg('m-2', 'two'))).content).toBe('scripted reply 2')
    expect((await first.gateway.send(msg('m-3', 'three'))).content).toBe('scripted reply 3')

    const snap = await takeSnapshot(first.storage, join(first.dataDir, 'snapshots'), 'manual')
    expect(snap.state).toBe('verified')

    // Fourth turn happens after the snapshot and must not appear in the restored database.
    expect((await first.gateway.send(msg('m-4', 'four'))).content).toBe('scripted reply 4')
    await first.close()

    const restoredDir = tmpDir('aira-restore-')
    copyFileSync(join(first.dataDir, 'snapshots', snap.file), join(restoredDir, 'aira.db'))

    const runner = scriptedRunner(() => 'restored reply')
    const restored = await startTestCore({ dataDir: restoredDir, runner })

    restored.storage.check()

    const deliveredTurns = restored.storage.read(
      (db) => db.prepare("SELECT count(*) FROM turn WHERE state = 'delivered'").pluck().get() as number
    )
    const assistantRows = restored.storage.read(
      (db) => db.prepare("SELECT count(*) FROM session_message WHERE role = 'assistant'").pluck().get() as number
    )
    expect(deliveredTurns).toBe(3)
    expect(assistantRows).toBe(3)

    const chatStatus = restored.storage.read(
      (db) => db.prepare('SELECT status FROM chat WHERE chat_id = ?').pluck().get(chatId) as string
    )
    expect(chatStatus).toBe('active')
    expect(resolveSetting(restored.storage, { chatId, type: 'group' }, 'character').value).toBe('example')

    const fifth = await restored.gateway.send(msg('m-5', 'five'))
    expect(fifth.status).toBe('delivered')
    expect(fifth.content).toBe('restored reply')

    expect(runner.inputs).toHaveLength(1)
    expect(runner.inputs[0]?.messages).toEqual([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'scripted reply 1' },
      { role: 'user', content: 'two' },
      { role: 'assistant', content: 'scripted reply 2' },
      { role: 'user', content: 'three' },
      { role: 'assistant', content: 'scripted reply 3' },
      { role: 'user', content: 'five' }
    ])

    // Repeating an old message id returns the stored reply without running the model.
    const repeated = await restored.gateway.send(msg('m-1', 'one'))
    expect(repeated.content).toBe('scripted reply 1')
    expect(runner.inputs).toHaveLength(1)
  })
})
