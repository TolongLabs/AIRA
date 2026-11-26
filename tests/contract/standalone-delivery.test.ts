import { describe, expect, it } from 'vitest'
import { createStandaloneDeliveryLedger } from '../../src/gateway/standalone-delivery.js'
import { ensureChat, setChatStatus } from '../../src/settings/chats.js'
import { openDatabase, type Storage } from '../../src/storage/database.js'
import { planMigrations, readMigrations } from '../../src/storage/migrate.js'
import { closeTurn, openTurn, receiveInbound } from '../../src/storage/turns.js'
import { tmpStorage } from '../support/tmp.js'

const ROUTE_A = '00000000-0000-4000-8000-000000000001'
const ROUTE_B = '00000000-0000-4000-8000-000000000002'

function returned(
  storage: Storage,
  input: { chatId: string; mid: string; turnId: string; text: string; state?: 'delivered' | 'failed' }
) {
  const senderId = 'synthetic-subject'
  receiveInbound(storage, { chatId: input.chatId, mid: input.mid, senderId })
  openTurn(storage, { turnId: input.turnId, chatId: input.chatId, senderId, kind: 'reply', mids: [input.mid] })
  expect(
    closeTurn(storage, {
      turnId: input.turnId,
      state: input.state ?? 'delivered',
      reply: input.text,
      replyMid: input.mid
    })
  ).toBe(true)
}

function fixture() {
  const storage = tmpStorage()
  const a = ensureChat(storage, { waId: 'fixture-a@lid', type: 'dm' })
  const b = ensureChat(storage, { waId: 'fixture-b@lid', type: 'dm' })
  for (const chat of [a, b]) setChatStatus(storage, { chatId: chat.chatId, status: 'active', actor: 'fixture' })
  let route: string | null = ROUTE_A
  let now = new Date('2026-01-01T00:00:00Z')
  const clock = () => now
  const ledger = createStandaloneDeliveryLedger(storage, { currentRoute: () => route, now: clock })
  const input = { routeId: ROUTE_A, chatId: a.chatId, mid: 'message-a', turnId: 'turn-a', replayed: false }
  return {
    storage,
    ledger,
    input,
    otherChat: b.chatId,
    changeRoute: (value: string | null) => (route = value),
    expire: () => (now = new Date('2026-01-01T00:10:00Z'))
  }
}

describe('standalone typed delivery ledger', () => {
  it('issues once, claims once, and acknowledges a confirmed result independently', () => {
    const { storage, ledger, input } = fixture()
    returned(storage, { ...input, text: 'hello\nMEDIA:untrusted-directive\nworld' })
    const [delivery] = ledger.issue(input)
    expect(delivery).toMatchObject({ kind: 'text', id: expect.any(String) })
    if (!delivery) throw new Error('missing delivery')
    const { routeId, chatId, mid } = input
    const claim = { routeId, chatId, mid, id: delivery.id }
    expect(ledger.ack({ ...claim, outcome: 'confirmed' })).toBe(false)
    expect(ledger.claim(claim)).toEqual({ ...delivery, text: 'hello\nworld' })
    expect(ledger.claim(claim)).toBeNull()
    expect(ledger.ack({ ...claim, outcome: 'confirmed' })).toBe(true)
    expect(ledger.ack({ ...claim, outcome: 'confirmed' })).toBe(true)
    expect(ledger.ack({ ...claim, outcome: 'failed' })).toBe(false)
    expect(ledger.issue(input)).toEqual([])
    expect(ledger.issue({ ...input, replayed: true })).toEqual([])
    expect(ledger.hasIssued(input)).toBe(true)
    expect(ledger.hasIssued({ ...input, mid: 'other' })).toBe(false)
    const row = storage.read((db) => db.prepare('SELECT * FROM standalone_delivery').get())
    expect(row).toMatchObject({ state: 'confirmed', turn_id: input.turnId, chat_id: chatId })
    expect(JSON.stringify(row)).not.toContain('hello')
  })

  it('refuses cross-chat, cross-message, stale route and inactive chat claims', () => {
    const { storage, ledger, input, otherChat, changeRoute } = fixture()
    returned(storage, { ...input, text: 'original only' })
    const [delivery] = ledger.issue(input)
    if (!delivery) throw new Error('missing delivery')
    const claim = { routeId: input.routeId, chatId: input.chatId, mid: input.mid, id: delivery.id }
    expect(ledger.claim({ ...claim, chatId: otherChat })).toBeNull()
    expect(ledger.claim({ ...claim, mid: 'foreign-mid' })).toBeNull()
    changeRoute(ROUTE_B)
    expect(ledger.claim(claim)).toBeNull()
    expect(ledger.claim({ ...claim, routeId: ROUTE_B })).toBeNull()
    expect(ledger.issue({ ...input, routeId: ROUTE_B })).toEqual([])
    changeRoute(ROUTE_A)
    setChatStatus(storage, { chatId: input.chatId, status: 'pending', actor: 'fixture' })
    expect(ledger.claim(claim)).toBeNull()
  })

  it('never issues a missing, replayed, no-reply, foreign or unbound turn', () => {
    const { storage, ledger, input, otherChat, changeRoute } = fixture()
    expect(ledger.issue(input)).toEqual([])
    returned(storage, { ...input, text: 'NO_REPLY' })
    expect(ledger.issue(input)).toEqual([])
    const next = { ...input, turnId: 'turn-b', mid: 'message-b' }
    returned(storage, { ...next, text: 'valid' })
    expect(ledger.issue({ ...next, replayed: true })).toEqual([])
    expect(ledger.issue({ ...next, chatId: otherChat })).toEqual([])
    expect(ledger.issue({ ...next, mid: 'unbound' })).toEqual([])
    changeRoute(null)
    expect(ledger.issue(next)).toEqual([])
    expect(storage.read((db) => db.prepare('SELECT count(*) FROM standalone_delivery').pluck().get())).toBe(0)
  })

  it('does not reclaim an expired or ambiguous send after reopening the database', () => {
    const { storage, ledger, input } = fixture()
    returned(storage, { ...input, text: 'ambiguous' })
    const [delivery] = ledger.issue(input)
    if (!delivery) throw new Error('missing delivery')
    const claim = { routeId: input.routeId, chatId: input.chatId, mid: input.mid, id: delivery.id }
    expect(ledger.claim(claim)).not.toBeNull()
    storage.close()
    const reopened = openDatabase(storage.file)
    try {
      let now = new Date('2026-01-01T00:01:00Z')
      const afterRestart = createStandaloneDeliveryLedger(reopened, {
        currentRoute: () => ROUTE_A,
        now: () => now
      })
      expect(afterRestart.claim(claim)).toBeNull()
      expect(afterRestart.ack({ ...claim, outcome: 'unknown' })).toBe(true)
      const later = { ...input, turnId: 'turn-c', mid: 'message-c' }
      returned(reopened, { ...later, text: 'expired' })
      const [pending] = afterRestart.issue(later)
      if (!pending) throw new Error('missing pending delivery')
      now = new Date('2026-01-01T00:11:00Z')
      expect(afterRestart.claim({ ...claim, mid: later.mid, id: pending.id })).toBeNull()
      expect(afterRestart.issue(later)).toEqual([])
      reopened.check()
    } finally {
      reopened.close()
    }
  })

  it('keeps v1-compatible fallback text and allows a late acknowledgement on the same route', () => {
    const { storage, ledger, input, expire } = fixture()
    returned(storage, { ...input, text: 'fallback reply', state: 'failed' })
    const [delivery] = ledger.issue(input)
    if (!delivery) throw new Error('missing delivery')
    const claim = { routeId: input.routeId, chatId: input.chatId, mid: input.mid, id: delivery.id }
    expect(ledger.claim(claim)).toMatchObject({ text: 'fallback reply' })
    expire()
    expect(ledger.ack({ ...claim, outcome: 'confirmed' })).toBe(true)
  })

  it('is additive for schemas 17 and 18 and does not obstruct turn retention', () => {
    const { storage, ledger, input } = fixture()
    expect(planMigrations(storage, readMigrations().slice(0, 17))).toMatchObject({ pending: [], newer: [18, 19, 20] })
    expect(planMigrations(storage, readMigrations().slice(0, 18))).toMatchObject({ pending: [], newer: [19, 20] })
    expect(planMigrations(storage, readMigrations().slice(0, 19))).toMatchObject({ pending: [], newer: [20] })
    returned(storage, { ...input, text: 'retained until turn deletion' })
    expect(ledger.issue(input)).toHaveLength(1)
    storage.tx((db) => {
      db.prepare('DELETE FROM inbound_message WHERE turn_id = ?').run(input.turnId)
      db.prepare('DELETE FROM session_message WHERE turn_id = ?').run(input.turnId)
      db.prepare('DELETE FROM turn WHERE turn_id = ?').run(input.turnId)
    })
    expect(storage.read((db) => db.prepare('SELECT count(*) FROM standalone_delivery').pluck().get())).toBe(0)
    storage.check()
  })
})
