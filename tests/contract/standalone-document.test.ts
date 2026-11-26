import { rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createStandaloneDeliveryLedger } from '../../src/gateway/standalone-delivery.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { putFile } from '../../src/storage/files.js'
import { closeTurn, openTurn, receiveInbound } from '../../src/storage/turns.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

const ROUTE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const text = Buffer.from('# Synthetic Report\n\nFixture only.\n')

function fixture() {
  const storage = tmpStorage()
  const filesDir = tmpDir('aira-document-')
  const chat = ensureChat(storage, { waId: 'fixture-a@lid', type: 'dm' })
  const foreign = ensureChat(storage, { waId: 'fixture-b@lid', type: 'dm' })
  setChatStatus(storage, { chatId: chat.chatId, status: 'active', actor: 'fixture' })
  const input = { routeId: ROUTE, chatId: chat.chatId, turnId: 'fixture-turn', mid: 'fixture-mid', replayed: false }
  const senderId = 'fixture-subject'
  receiveInbound(storage, { chatId: chat.chatId, mid: input.mid, senderId })
  openTurn(storage, { turnId: input.turnId, chatId: chat.chatId, senderId, kind: 'reply', mids: [input.mid] })
  closeTurn(storage, { turnId: input.turnId, state: 'delivered', reply: 'Report ready.', replyMid: input.mid })
  let documents = true
  let route: string | null = ROUTE
  const ledger = createStandaloneDeliveryLedger(storage, {
    currentRoute: () => route,
    filesDir,
    mayDeliverDocument: () => documents
  })
  let call = 0
  function report(data = text, options: { chatId?: string; ok?: boolean; ext?: string; statePath?: string } = {}) {
    const file = putFile(storage, filesDir, { data, ext: options.ext ?? '.md', kind: 'report' })
    const callId = `fixture-call-${++call}`
    const chatId = options.chatId ?? chat.chatId
    storage.tx((db) => {
      db.prepare(`INSERT INTO tool_result (call_id,turn_id,chat_id,tool,result,created_at) VALUES (?,?,?,?,?,?)`).run(
        callId,
        input.turnId,
        chatId,
        'make_report',
        JSON.stringify({ ok: options.ok ?? true, data: { created: true } }),
        '2026-01-01T00:00:00Z'
      )
      db.prepare(
        `INSERT INTO receipt (receipt_id,call_id,turn_id,chat_id,tool,kind,target,state,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(
        `fixture-receipt-${call}`,
        callId,
        input.turnId,
        chatId,
        'make_report',
        'report.created',
        file.sha256,
        JSON.stringify({ attachment: options.statePath ?? file.path }),
        '2026-01-01T00:00:00Z'
      )
    })
    return file
  }
  const bind = (id: string) => ({ routeId: input.routeId, chatId: input.chatId, mid: input.mid, id })
  return {
    storage,
    filesDir,
    input,
    foreign,
    ledger,
    report,
    bind,
    disable: () => {
      documents = false
    },
    detach: () => {
      route = null
    }
  }
}

describe('receipt-backed portable documents', () => {
  it('issues one clean text and one same-turn document, then claims verified bytes once', () => {
    const { ledger, input, report, bind } = fixture()
    const file = report()
    report(Buffer.from('Second report should not deliver.'))
    const descriptors = ledger.issue(input)
    expect(descriptors.map((item) => item.kind)).toEqual(['text', 'document'])
    const document = descriptors[1]!
    expect(Object.keys(document).sort()).toEqual(['id', 'kind'])
    const claim = bind(document.id)
    expect(ledger.claim(claim)).toEqual({
      ...document,
      mime: 'text/markdown',
      filename: 'report.md',
      sha256: file.sha256,
      base64: text.toString('base64')
    })
    expect(ledger.claim(claim)).toBeNull()
    expect(ledger.ack({ ...claim, outcome: 'unknown' })).toBe(true)
    expect(ledger.issue(input)).toEqual([])
  })

  it.each(['foreign', 'failed', 'path', 'type', 'utf8', 'oversize', 'symlink'] as const)(
    'does not issue a document from %s content or receipt',
    (kind) => {
      const { ledger, input, report, filesDir, foreign } = fixture()
      const file =
        kind === 'foreign'
          ? report(text, { chatId: foreign.chatId })
          : kind === 'failed'
            ? report(text, { ok: false })
            : kind === 'path'
              ? report(text, { statePath: '../synthetic.md' })
              : kind === 'type'
                ? report(text, { ext: '.pdf' })
                : kind === 'utf8'
                  ? report(Buffer.from([0xff, 0xfe]))
                  : kind === 'oversize'
                    ? report(Buffer.alloc(5_242_881, 65))
                    : report()
      if (kind === 'symlink') {
        const path = join(filesDir, file.path)
        const substitute = join(filesDir, 'substitute.md')
        writeFileSync(substitute, text)
        rmSync(path)
        symlinkSync(substitute, path)
      }
      expect(ledger.issue(input).map((item) => item.kind)).toEqual(['text'])
    }
  )

  it('refuses changed content, revoked capability and stale route at claim', () => {
    for (const reason of ['changed', 'disabled', 'detached']) {
      const { ledger, input, report, filesDir, bind, disable, detach } = fixture()
      const file = report()
      const descriptors = ledger.issue(input)
      expect(descriptors).toHaveLength(2)
      if (reason === 'changed') writeFileSync(join(filesDir, file.path), Buffer.alloc(text.length, 65))
      if (reason === 'disabled') disable()
      if (reason === 'detached') detach()
      expect(ledger.claim(bind(descriptors[1]!.id))).toBeNull()
    }
  })

  it('keeps text-only and no-report capability paths unchanged', () => {
    const { ledger, input, report, disable } = fixture()
    report()
    disable()
    expect(ledger.issue(input).map((item) => item.kind)).toEqual(['text'])
  })
})
