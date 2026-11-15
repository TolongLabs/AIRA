import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { createMemoryPort } from '../../src/memory/port.js'
import { recallForTurn, searchHistory, searchMemory } from '../../src/memory/recall.js'
import {
  addNote,
  addSummary,
  applyOperation,
  expireUpcoming,
  forgetBarrier,
  forgetItem,
  getItem,
  setLingo
} from '../../src/memory/store.js'
import { ensureChat } from '../../src/settings/chats.js'
import type { Storage } from '../../src/storage/database.js'
import { tmpStorage } from '../support/tmp.js'

function walkTs(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkTs(full))
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

function snapshotChat(storage: Storage, chatId: string) {
  return storage.read((db) => ({
    items: db.prepare('SELECT * FROM memory_item WHERE chat_id = ? ORDER BY id').all(chatId),
    fts: db.prepare('SELECT * FROM memory_fts WHERE chat_id = ? ORDER BY item_id').all(chatId),
    embeddings: db.prepare('SELECT * FROM memory_embedding WHERE chat_id = ? ORDER BY item_id').all(chatId),
    cursor: db.prepare('SELECT * FROM memory_cursor WHERE chat_id = ?').get(chatId),
    events: db.prepare('SELECT * FROM memory_event WHERE chat_id = ? ORDER BY id').all(chatId),
    messages: db.prepare('SELECT * FROM session_message WHERE chat_id = ? ORDER BY id').all(chatId)
  }))
}

describe('memory chat isolation', () => {
  it('never leaks facts, notes, lingo, upcoming facts, episodes or history across chats sharing a subject', () => {
    const storage = tmpStorage()
    const chatA = ensureChat(storage, { waId: 'fake-dm-a', type: 'dm' })
    const chatB = ensureChat(storage, { waId: 'fake-dm-b', type: 'group' })
    const sharedSubject = 'subj-shared'
    const present = new Map([[sharedSubject, 'member 1']])

    const idsA: string[] = []
    const idsB: string[] = []

    storage.tx((db) => {
      const a1 = applyOperation(
        db,
        chatA.chatId,
        { op: 'add', subjectId: sharedSubject, key: 'likes.drink', value: 'shareddrink alphaword', quote: 'q' },
        {}
      )
      const a2 = applyOperation(
        db,
        chatA.chatId,
        {
          op: 'add',
          subjectId: sharedSubject,
          key: 'trip',
          value: 'upcoming alphaword',
          quote: 'q',
          validUntil: '2027-06-01T00:00:00.000Z'
        },
        {}
      )
      const aNote = addNote(db, chatA.chatId, { subjectId: sharedSubject, text: 'note alphaword sharedword' })
      const aLingo = setLingo(db, chatA.chatId, { word: 'glossa', meaning: 'meaning alphaword' })
      const aEp = addSummary(db, chatA.chatId, { kind: 'episode', value: 'episode alphaword sharedword' })
      db.prepare(
        "INSERT INTO session_message (chat_id, role, sender_id, content, created_at) VALUES (?, 'user', ?, 'window alphaword sharedword', '2026-11-16T00:00:00.000Z')"
      ).run(chatA.chatId, sharedSubject)

      if (a1.accepted) idsA.push(a1.itemId)
      if (a2.accepted) idsA.push(a2.itemId)
      idsA.push(aNote.itemId, aLingo, aEp)

      const b1 = applyOperation(
        db,
        chatB.chatId,
        { op: 'add', subjectId: sharedSubject, key: 'likes.drink', value: 'shareddrink betaword', quote: 'q' },
        {}
      )
      const b2 = applyOperation(
        db,
        chatB.chatId,
        {
          op: 'add',
          subjectId: sharedSubject,
          key: 'trip',
          value: 'upcoming betaword',
          quote: 'q',
          validUntil: '2027-06-01T00:00:00.000Z'
        },
        {}
      )
      const bNote = addNote(db, chatB.chatId, { subjectId: sharedSubject, text: 'note betaword sharedword' })
      const bLingo = setLingo(db, chatB.chatId, { word: 'glossb', meaning: 'meaning betaword' })
      const bEp = addSummary(db, chatB.chatId, { kind: 'episode', value: 'episode betaword sharedword' })
      db.prepare(
        "INSERT INTO session_message (chat_id, role, sender_id, content, created_at) VALUES (?, 'user', ?, 'window betaword sharedword', '2026-11-16T00:00:00.000Z')"
      ).run(chatB.chatId, sharedSubject)

      if (b1.accepted) idsB.push(b1.itemId)
      if (b2.accepted) idsB.push(b2.itemId)
      idsB.push(bNote.itemId, bLingo, bEp)
    })

    const port = createMemoryPort({ storage, verifyThreshold: 0.5, timeoutMs: 100 })
    const queries = ['alphaword', 'betaword', 'sharedword', 'shareddrink']

    const outA = JSON.stringify([
      queries.map((q) => searchMemory(storage, chatA.chatId, q, 20)),
      queries.map((q) => searchHistory(storage, chatA.chatId, q, 20)),
      recallForTurn(storage, { chatId: chatA.chatId, present, queryTexts: queries, tokenBudget: 2000 }),
      queries.map((q) => port.recall(chatA.chatId, q, 20)),
      queries.map((q) => port.history(chatA.chatId, q, 20)),
      storage.read((db) => idsB.map((id) => getItem(db, chatA.chatId, id)))
    ])
    expect(outA).not.toContain('betaword')
    for (const idB of idsB) {
      expect(outA).not.toContain(idB)
    }

    const outB = JSON.stringify([
      queries.map((q) => searchMemory(storage, chatB.chatId, q, 20)),
      queries.map((q) => searchHistory(storage, chatB.chatId, q, 20)),
      recallForTurn(storage, { chatId: chatB.chatId, present, queryTexts: queries, tokenBudget: 2000 }),
      queries.map((q) => port.recall(chatB.chatId, q, 20)),
      queries.map((q) => port.history(chatB.chatId, q, 20)),
      storage.read((db) => idsA.map((id) => getItem(db, chatB.chatId, id)))
    ])
    expect(outB).not.toContain('alphaword')
    for (const idA of idsA) {
      expect(outB).not.toContain(idA)
    }

    const bBefore = snapshotChat(storage, chatB.chatId)
    const crossForget = storage.tx((db) => forgetItem(db, chatA.chatId, idsB[0] ?? ''))
    expect(crossForget).toBe(false)
    expect(snapshotChat(storage, chatB.chatId)).toEqual(bBefore)

    // Writes and forgets in A never alter any row of B
    storage.tx((db) => {
      applyOperation(
        db,
        chatA.chatId,
        { op: 'add', subjectId: sharedSubject, key: 'extra', value: 'only a', quote: 'q' },
        {}
      )
      addNote(db, chatA.chatId, { subjectId: sharedSubject, text: 'second note only a' })
      setLingo(db, chatA.chatId, { word: 'glossa', meaning: 'updated alphaword' })
      forgetBarrier(db, chatA.chatId)
      expireUpcoming(db, chatA.chatId, () => new Date('2028-01-01T00:00:00.000Z'))
      forgetItem(db, chatA.chatId, idsA[0] ?? '')
    })
    expect(snapshotChat(storage, chatB.chatId)).toEqual(bBefore)
    expect(searchMemory(storage, chatB.chatId, 'shareddrink', 10)).toHaveLength(1)
  })

  it('SQL gate: memory tables appear only in src/memory and src/storage, and every memory SQL statement filters by chat_id', () => {
    const tables = ['memory_item', 'memory_fts', 'memory_embedding', 'memory_cursor', 'memory_event']
    const tableRe = new RegExp(`\\b(${tables.join('|')})\\b`)
    const sqlVerbRe = /\b(SELECT|UPDATE|DELETE|INSERT)\b/i

    for (const file of walkTs('src')) {
      const normalized = file.replaceAll('\\', '/')
      const content = readFileSync(file, 'utf8')
      const inMemory = normalized.startsWith('src/memory/')
      const inStorage = normalized.startsWith('src/storage/')

      if (!inMemory && !inStorage) {
        for (const table of tables) {
          expect(content, `${file} references ${table}`).not.toMatch(new RegExp(`\\b${table}\\b`))
        }
        continue
      }

      if (inMemory) {
        const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, content)
        let token = scanner.scan()
        while (token !== ts.SyntaxKind.EndOfFileToken) {
          if (
            token === ts.SyntaxKind.StringLiteral ||
            token === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
            token === ts.SyntaxKind.TemplateHead ||
            token === ts.SyntaxKind.TemplateMiddle ||
            token === ts.SyntaxKind.TemplateTail
          ) {
            const literal = scanner.getTokenValue()
            if (tableRe.test(literal) && sqlVerbRe.test(literal)) {
              expect(literal, `${file}: missing chat_id in SQL: ${literal}`).toContain('chat_id')
            }
          }
          token = scanner.scan()
        }
      }
    }
  })
})
