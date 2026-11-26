import { spawnSync } from 'node:child_process'
import { rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createStandaloneDeliveryLedger } from '../../src/gateway/standalone-delivery.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { openDatabase } from '../../src/storage/database.js'
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
  let now = new Date('2026-01-01T00:00:00Z')
  const ledger = createStandaloneDeliveryLedger(storage, {
    now: () => now,
    currentRoute: () => route,
    filesDir,
    mayDeliverDocument: () => documents
  })
  let call = 0
  function report(
    data = text,
    options: { chatId?: string; turnId?: string; ok?: boolean; ext?: string; statePath?: string } = {}
  ) {
    const file = putFile(storage, filesDir, { data, ext: options.ext ?? '.md', kind: 'report' })
    const callId = `fixture-call-${++call}`
    const chatId = options.chatId ?? chat.chatId
    storage.tx((db) => {
      db.prepare(`INSERT INTO tool_result (call_id,turn_id,chat_id,tool,result,created_at) VALUES (?,?,?,?,?,?)`).run(
        callId,
        options.turnId ?? input.turnId,
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
        options.turnId ?? input.turnId,
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
    expire: () => {
      now = new Date('2026-01-01T00:10:00Z')
    },
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

  it.each([
    'foreign',
    'failed',
    'path',
    'type',
    'utf8',
    'oversize',
    'symlink',
    'fifo',
    'missing-file',
    'missing-row',
    'foreign-turn'
  ] as const)('does not issue a document from %s content or receipt', (kind) => {
    const { storage, ledger, input, report, filesDir, foreign } = fixture()
    const foreignTurn = 'foreign-turn'
    if (kind === 'foreign-turn') {
      receiveInbound(storage, { chatId: input.chatId, mid: 'foreign-mid', senderId: 'fixture-subject' })
      openTurn(storage, {
        turnId: foreignTurn,
        chatId: input.chatId,
        senderId: 'fixture-subject',
        kind: 'reply',
        mids: ['foreign-mid']
      })
      closeTurn(storage, { turnId: foreignTurn, state: 'delivered', reply: 'Other report.', replyMid: 'foreign-mid' })
    }
    const file =
      kind === 'foreign'
        ? report(text, { chatId: foreign.chatId })
        : kind === 'foreign-turn'
          ? report(text, { turnId: foreignTurn })
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
    if (kind === 'fifo') {
      const path = join(filesDir, file.path)
      rmSync(path)
      expect(spawnSync('mkfifo', [path]).status).toBe(0)
    }
    if (kind === 'missing-file') rmSync(join(filesDir, file.path))
    if (kind === 'missing-row') storage.tx((db) => db.prepare('DELETE FROM file WHERE sha256 = ?').run(file.sha256))
    expect(ledger.issue(input).map((item) => item.kind)).toEqual(['text'])
  })

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

  it('refuses a replacement receipt even when its chat, turn and file hash agree', () => {
    const { storage, ledger, input, report, bind } = fixture()
    report()
    const issued = ledger.issue(input)
    expect(issued).toHaveLength(2)
    const claim = bind(issued[1]!.id)
    report()
    storage.tx((db) => db.prepare('DELETE FROM receipt WHERE receipt_id = ?').run('fixture-receipt-1'))
    expect(ledger.claim(claim)).toBeNull()
  })

  it('does not claim an expired or previously claimed document across a real database reopen', () => {
    for (const reason of ['expired', 'claimed']) {
      const { storage, filesDir, ledger, input, report, bind, expire } = fixture()
      report()
      const issued = ledger.issue(input)
      expect(issued).toHaveLength(2)
      const claim = bind(issued[1]!.id)
      if (reason === 'expired') {
        expire()
        expect(ledger.claim(claim)).toBeNull()
      } else {
        expect(ledger.claim(claim)?.kind).toBe('document')
      }
      storage.close()
      const reopened = openDatabase(storage.file)
      try {
        const afterRestart = createStandaloneDeliveryLedger(reopened, {
          filesDir,
          currentRoute: () => ROUTE,
          mayDeliverDocument: () => true,
          now: () => new Date(reason === 'expired' ? '2026-01-01T00:10:00Z' : '2026-01-01T00:01:00Z')
        })
        expect(afterRestart.claim(claim)).toBeNull()
        expect(afterRestart.issue(input)).toEqual([])
        if (reason === 'claimed') expect(afterRestart.ack({ ...claim, outcome: 'unknown' })).toBe(true)
      } finally {
        reopened.close()
      }
    }
  })

  it('keeps text-only and no-report capability paths unchanged', () => {
    const { ledger, input, report, disable } = fixture()
    report()
    disable()
    expect(ledger.issue(input).map((item) => item.kind)).toEqual(['text'])
  })
})
