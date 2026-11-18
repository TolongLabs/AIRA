import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyFeedbackSubmission,
  feedbackCursor,
  openFeedbackReport,
  pruneFeedbackAnswers
} from '../../src/feedback/store.js'
import { createFeedbackSync } from '../../src/feedback/sync.js'
import { createLogger } from '../../src/records/logger.js'
import { createRedactor } from '../../src/records/redact.js'
import { pruneRecords } from '../../src/records/retention.js'
import { type Db, openDatabase, type Storage } from '../../src/storage/database.js'
import { applyMigrations } from '../../src/storage/migrate.js'
import { tmpDir, tmpStorage } from '../support/tmp.js'

afterEach(() => {
  vi.restoreAllMocks()
})

const NOW = '2026-11-18T00:00:00.000Z'
const LATER = '2026-11-25T00:00:00.000Z'
const SECRET = 'test-feedback-sync-secret-1234567890'

interface ScriptRequest {
  secret: string
  after: number
  limit: number
}

async function startScript(
  respond: (request: ScriptRequest) => unknown
): Promise<{ url: string; fetch: typeof fetch; requests: ScriptRequest[]; close(): Promise<void> }> {
  const requests: ScriptRequest[] = []
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ScriptRequest
      requests.push(parsed)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(respond(parsed)))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    url: 'https://feedback.invalid/exec',
    fetch: (_input, init) => fetch(`http://127.0.0.1:${address.port}`, init),
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}

function insertTurn(
  db: Db,
  input: { turnId: string; chatId: string; subjectId: string; at: string; state?: 'running' | 'delivered' }
): void {
  const state = input.state ?? 'delivered'
  db.prepare(
    `INSERT INTO turn (turn_id, chat_id, sender_id, kind, state, stage, received_at, ended_at)
     VALUES (?, ?, ?, 'command', ?, 'returned', ?, ?)`
  ).run(input.turnId, input.chatId, input.subjectId, state, input.at, state === 'running' ? null : input.at)
}

function seedConversation(storage: Storage, chatId = 'chat-feedback', subjectId = 'subject-feedback'): string {
  const commandTurnId = `${chatId}-command-${subjectId}`
  storage.tx((db) => {
    for (let index = 0; index < 6; index++) {
      insertTurn(db, {
        turnId: `${chatId}-turn-${index}`,
        chatId,
        subjectId,
        at: `2026-11-17T0${index}:00:00.000Z`
      })
    }
    insertTurn(db, { turnId: commandTurnId, chatId, subjectId, at: NOW, state: 'running' })
  })
  return commandTurnId
}

function openReport(storage: Storage, input: { chatId?: string; subjectId?: string; expiresAt?: string } = {}) {
  const chatId = input.chatId ?? 'chat-feedback'
  const subjectId = input.subjectId ?? 'subject-feedback'
  const turnId = seedConversation(storage, chatId, subjectId)
  return storage.tx((db) =>
    openFeedbackReport(db, {
      chatId,
      subjectId,
      turnId,
      issuedAt: NOW,
      expiresAt: input.expiresAt ?? LATER
    })
  )
}

function row(seq: number, ref: string, whatWentWrong = 'AIRA gave the wrong answer') {
  return {
    seq,
    ref,
    submittedAt: '2026-11-18T00:01:00.000Z',
    answers: {
      whatWentWrong,
      expected: 'A correct answer',
      kind: 'Wrong answer',
      when: 'Today',
      severity: 'Medium'
    }
  }
}

function syncHarness(
  storage: Storage,
  input: { url: string; secret?: string; now?: string; fetch?: typeof fetch; onFailure?: () => void },
  logs: Record<string, unknown>[] = []
) {
  const secret = input.secret ?? SECRET
  const redactor = createRedactor({ secrets: [secret] })
  return createFeedbackSync({
    storage,
    url: input.url,
    secret,
    enabled: () => true,
    redactor,
    logger: createLogger({ level: 'debug', module: 'test', redactor, sink: (line) => logs.push(JSON.parse(line)) }),
    now: () => new Date(input.now ?? NOW),
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.onFailure ? { onFailure: input.onFailure } : {})
  })
}

describe('feedback persistence and sync', () => {
  it('reuses one open report and freezes only the five newest completed turn ids', () => {
    const storage = tmpStorage()
    const first = openReport(storage)
    const second = storage.tx((db) =>
      openFeedbackReport(db, {
        chatId: 'chat-feedback',
        subjectId: 'subject-feedback',
        turnId: 'chat-feedback-command-subject-feedback',
        issuedAt: NOW,
        expiresAt: LATER
      })
    )

    expect(first.created).toBe(true)
    expect(second).toEqual({ ...first, created: false })
    expect(first.reference).toMatch(/^[a-z2-7]{10}$/)
    expect(first.turnIds).toEqual([
      'chat-feedback-turn-1',
      'chat-feedback-turn-2',
      'chat-feedback-turn-3',
      'chat-feedback-turn-4',
      'chat-feedback-turn-5'
    ])
    expect(storage.read((db) => db.prepare('SELECT count(*) FROM feedback_report').pluck().get())).toBe(1)
  })

  it('accepts a fake Apps Script row atomically and replays it safely after restart', async () => {
    const storage = tmpStorage()
    const report = openReport(storage)
    const script = await startScript((request) => ({ rows: [row(1, report.reference)], after: request.after + 1 }))
    const logs: Record<string, unknown>[] = []
    try {
      await syncHarness(storage, { url: script.url, fetch: script.fetch }, logs).tick()

      const stored = storage.read((db) =>
        db.prepare('SELECT state, form_seq, answers FROM feedback_report WHERE report_id = ?').get(report.reportId)
      ) as { state: string; form_seq: number; answers: string }
      expect(stored.state).toBe('received')
      expect(stored.form_seq).toBe(1)
      expect(JSON.parse(stored.answers)).toMatchObject({ whatWentWrong: 'AIRA gave the wrong answer' })
      expect(storage.read(feedbackCursor)).toBe(1)

      openReport(storage, { chatId: 'chat-pending', subjectId: 'subject-pending' })
      await syncHarness(storage, { url: script.url, fetch: script.fetch }, logs).tick()
      expect(storage.read(feedbackCursor)).toBe(1)
      expect(script.requests.map((request) => request.after)).toEqual([0, 1])
      expect(storage.read((db) => db.prepare('SELECT count(*) FROM failure').pluck().get())).toBe(0)
      expect(JSON.stringify(logs)).not.toContain(report.reference)
      expect(JSON.stringify(logs)).not.toContain('subject-feedback')
      expect(JSON.stringify(logs)).not.toContain('AIRA gave the wrong answer')
    } finally {
      await script.close()
    }
  })

  it('rejects unknown, expired and reused references while advancing each classified sequence', async () => {
    const storage = tmpStorage()
    const valid = openReport(storage, { chatId: 'chat-valid', subjectId: 'subject-valid' })
    const expired = openReport(storage, {
      chatId: 'chat-expired',
      subjectId: 'subject-expired',
      expiresAt: '2026-11-17T23:59:59.000Z'
    })
    const script = await startScript(() => ({
      rows: [
        row(1, 'zzzzzzzzzz'),
        row(2, expired.reference),
        row(3, valid.reference),
        row(4, valid.reference, 'A second submission')
      ],
      after: 4
    }))
    try {
      await syncHarness(storage, { url: script.url, fetch: script.fetch }).tick()

      expect(storage.read(feedbackCursor)).toBe(4)
      expect(
        storage.read((db) =>
          db.prepare('SELECT state, answers FROM feedback_report WHERE report_id = ?').get(expired.reportId)
        )
      ).toEqual({ state: 'expired', answers: null })
      expect(
        storage.read((db) =>
          db.prepare('SELECT state, form_seq FROM feedback_report WHERE report_id = ?').get(valid.reportId)
        )
      ).toEqual({ state: 'received', form_seq: 3 })
      expect(
        storage.read((db) => db.prepare("SELECT count(*) FROM failure WHERE kind = 'feedback_rejected'").pluck().get())
      ).toBe(3)
    } finally {
      await script.close()
    }
  })

  it('records denied and timeout sync failures without moving the cursor or exposing the secret', async () => {
    const storage = tmpStorage()
    openReport(storage)
    const script = await startScript(() => ({ error: 'denied' }))
    const logs: Record<string, unknown>[] = []
    let alerts = 0
    try {
      await syncHarness(storage, { url: script.url, fetch: script.fetch, onFailure: () => alerts++ }, logs).tick()
      expect(storage.read(feedbackCursor)).toBe(0)

      vi.spyOn(AbortSignal, 'timeout').mockReturnValue(
        AbortSignal.abort(new DOMException('request timed out', 'TimeoutError'))
      )
      const timedOutFetch = vi.fn<typeof fetch>(async (_input, init) => {
        init?.signal?.throwIfAborted()
        return new Response('{}')
      })
      await syncHarness(storage, { url: script.url, fetch: timedOutFetch, onFailure: () => alerts++ }, logs).tick()

      expect(storage.read(feedbackCursor)).toBe(0)
      expect(alerts).toBe(2)
      expect(
        storage.read((db) =>
          db.prepare("SELECT count(*) FROM failure WHERE kind = 'feedback_sync_failed'").pluck().get()
        )
      ).toBe(2)
      const serialized = JSON.stringify(logs)
      expect(serialized).not.toContain(SECRET)
      expect(serialized).not.toContain('request timed out')
    } finally {
      await script.close()
    }
  })

  it('does not call Google without an open report', async () => {
    const storage = tmpStorage()
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ rows: [], after: 0 })))

    await syncHarness(storage, { url: 'https://feedback.invalid/exec', fetch: fetcher }).tick()

    expect(fetcher).not.toHaveBeenCalled()
    expect(
      storage.read((db) => db.prepare("SELECT count(*) FROM job_run WHERE kind = 'feedback_sync'").pluck().get())
    ).toBe(0)
  })

  it('refuses to send the shared secret to a non-TLS endpoint', async () => {
    const storage = tmpStorage()
    openReport(storage)
    const fetcher = vi.fn<typeof fetch>()

    await syncHarness(storage, { url: 'http://feedback.invalid/exec', fetch: fetcher }).tick()

    expect(fetcher).not.toHaveBeenCalled()
    expect(storage.read(feedbackCursor)).toBe(0)
    expect(
      storage.read((db) => db.prepare("SELECT count(*) FROM failure WHERE kind = 'feedback_sync_failed'").pluck().get())
    ).toBe(1)
  })

  it('refuses an HTTPS redirect that would carry the secret to HTTP', async () => {
    const storage = tmpStorage()
    openReport(storage)
    const destinations: string[] = []
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      destinations.push(String(input))
      return new Response(null, { status: 307, headers: { location: 'http://feedback.invalid/leak' } })
    })

    await syncHarness(storage, { url: 'https://feedback.invalid/exec', fetch: fetcher }).tick()

    expect(destinations).toEqual(['https://feedback.invalid/exec'])
    expect(storage.read(feedbackCursor)).toBe(0)
    expect(
      storage.read((db) => db.prepare("SELECT count(*) FROM failure WHERE kind = 'feedback_sync_failed'").pluck().get())
    ).toBe(1)
  })

  it('follows an HTTPS 303 as GET without forwarding the secret body', async () => {
    const storage = tmpStorage()
    const report = openReport(storage)
    const signals: AbortSignal[] = []
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input) === 'https://feedback.invalid/exec') {
        expect(init?.method).toBe('POST')
        expect(init?.body).toContain(SECRET)
        expect(init?.redirect).toBe('manual')
        signals.push(init?.signal as AbortSignal)
        return new Response(null, {
          status: 303,
          headers: { location: 'https://feedback-result.invalid/batch' }
        })
      }

      expect(String(input)).toBe('https://feedback-result.invalid/batch')
      expect(init?.method).toBe('GET')
      expect(init?.headers).toBeUndefined()
      expect(init?.body).toBeUndefined()
      expect(init?.redirect).toBe('manual')
      signals.push(init?.signal as AbortSignal)
      return new Response(JSON.stringify({ rows: [row(1, report.reference)], after: 1 }))
    })

    await syncHarness(storage, { url: 'https://feedback.invalid/exec', fetch: fetcher }).tick()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(signals[0]).toBe(signals[1])
    expect(storage.read(feedbackCursor)).toBe(1)
    expect(
      storage.read((db) =>
        db.prepare('SELECT state FROM feedback_report WHERE report_id = ?').pluck().get(report.reportId)
      )
    ).toBe('received')
  })

  it('does not advance past a row whose transaction fails', async () => {
    const storage = tmpStorage()
    const first = openReport(storage, { chatId: 'chat-first', subjectId: 'subject-first' })
    const second = openReport(storage, { chatId: 'chat-second', subjectId: 'subject-second' })
    storage.tx((db) => {
      insertTurn(db, {
        turnId: 'conflict-command',
        chatId: 'chat-conflict',
        subjectId: 'subject-conflict',
        at: '2026-11-17T20:00:00.000Z',
        state: 'running'
      })
      db.prepare(
        `INSERT INTO feedback_report
           (report_id, ref, chat_id, subject_id, turn_id, turn_ids, state, issued_at, expires_at,
            received_at, form_seq, answers)
         VALUES ('fb_conflict', 'aaaaaaaaaa', 'chat-conflict', 'subject-conflict', 'conflict-command', '[]',
                 'received', ?, ?, ?, 2, '{}')`
      ).run(NOW, LATER, NOW)
    })
    const script = await startScript(() => ({ rows: [row(1, first.reference), row(2, second.reference)], after: 2 }))
    try {
      await syncHarness(storage, { url: script.url, fetch: script.fetch }).tick()

      expect(storage.read(feedbackCursor)).toBe(1)
      expect(
        storage.read((db) =>
          db.prepare('SELECT state, form_seq FROM feedback_report WHERE report_id = ?').get(first.reportId)
        )
      ).toEqual({ state: 'received', form_seq: 1 })
      expect(
        storage.read((db) =>
          db.prepare('SELECT state, form_seq, answers FROM feedback_report WHERE report_id = ?').get(second.reportId)
        )
      ).toEqual({ state: 'open', form_seq: null, answers: null })
      expect(
        storage.read((db) =>
          db.prepare("SELECT count(*) FROM failure WHERE kind = 'feedback_sync_failed'").pluck().get()
        )
      ).toBe(1)
    } finally {
      await script.close()
    }
  })

  it('rolls back a crashed row and accepts it cleanly after a real database reopen', () => {
    const dir = tmpDir('aira-feedback-restart-')
    const file = `${dir}/aira.db`
    const firstStorage = openDatabase(file)
    applyMigrations(firstStorage)
    const report = openReport(firstStorage)

    expect(() =>
      firstStorage.tx((db) => {
        classifyFeedbackSubmission(db, row(1, report.reference), { nowIso: NOW, jobId: 'crashed-job' })
        throw new Error('simulated crash before commit')
      })
    ).toThrow('simulated crash')
    firstStorage.close()

    const reopened = openDatabase(file)
    try {
      expect(reopened.read(feedbackCursor)).toBe(0)
      expect(
        reopened.read((db) =>
          db.prepare('SELECT state, form_seq FROM feedback_report WHERE report_id = ?').get(report.reportId)
        )
      ).toEqual({ state: 'open', form_seq: null })

      expect(
        reopened.tx((db) =>
          classifyFeedbackSubmission(db, row(1, report.reference), { nowIso: NOW, jobId: 'restarted-job' })
        )
      ).toBe('received')
      expect(reopened.read(feedbackCursor)).toBe(1)
      expect(
        reopened.read((db) =>
          db.prepare('SELECT state, form_seq, answers FROM feedback_report WHERE report_id = ?').get(report.reportId)
        )
      ).toMatchObject({ state: 'received', form_seq: 1 })
    } finally {
      reopened.close()
    }
  })

  it('retains report metadata when old turns and old answers are pruned', () => {
    const storage = tmpStorage()
    const report = openReport(storage)
    storage.tx((db) => {
      db.prepare(
        `UPDATE feedback_report SET state = 'received', form_seq = 1, answers = '{}', received_at = ?
         WHERE report_id = ?`
      ).run('2026-01-01T00:00:00.000Z', report.reportId)
      db.prepare("UPDATE turn SET state = 'delivered', received_at = ?, ended_at = ?").run(
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      )
    })
    const archivedTables: string[] = []

    const result = pruneRecords(
      storage,
      { retentionDays: 90, diagnosticsHours: 24, windowDays: 30, feedbackDays: 30 },
      { now: () => new Date(NOW), beforeDelete: (table) => archivedTables.push(table) }
    )

    expect(result.counts.turn).toBeGreaterThan(0)
    expect(result.counts.feedback_answers).toBe(1)
    expect(archivedTables).not.toContain('feedback_report')
    expect(
      storage.read((db) =>
        db.prepare('SELECT report_id, turn_id, answers FROM feedback_report WHERE report_id = ?').get(report.reportId)
      )
    ).toEqual({ report_id: report.reportId, turn_id: 'chat-feedback-command-subject-feedback', answers: null })
    expect(storage.tx((db) => pruneFeedbackAnswers(db, NOW))).toBe(0)
  })
})
