import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyStudioPatch,
  compareDrafts,
  diffDocs,
  listLeafChanges,
  putStudio,
  rebaseLeaves,
  validateDraft,
  type StudioDraft
} from '../src/dashboard/studio-client'

/* Synthetic fixtures only: an invented pack no real person uses. No model, no network. */

function testDraft(): StudioDraft {
  return {
    card: {
      id: 'test-pack',
      displayName: 'Test Pack',
      aliases: ['tester'],
      languages: ['en'],
      coreIdentity: 'A synthetic character for regression tests.',
      speechRules: ['Keep replies short.'],
      defaultReplyLength: 'default',
      toolFooter: { icon: '🧪', labels: { search: 'Search' } }
    },
    moods: {
      default: 'calm',
      faceGroups: { soft: ['(^_^)'] },
      beats: [{ name: 'aside', line: 'A short aside.' }],
      moods: {
        calm: {
          patterns: ['\\bcalm\\b'],
          tone: 'Even and warm.',
          openers: ['Hey.'],
          endings: ['See you.'],
          faces: ['(^_^)'],
          faceGroups: ['soft'],
          beats: { aside: 0.2 },
          stickers: ['calm.webp']
        },
        brisk: {
          patterns: ['\\bnow\\b'],
          tone: 'Quick and bright.',
          openers: ['Go!'],
          endings: ['Done.'],
          faces: ['(>_<)'],
          stickers: []
        }
      }
    },
    lines: {
      error: 'Test error line.',
      limit: 'Test limit line.',
      refusal: 'Test refusal line.',
      busy: 'Test busy line.',
      slow: 'Test slow line.',
      unreadableMedia: 'Test unreadable line.',
      fallback: 'Test fallback line.',
      unavailable: 'Test unavailable line.',
      feedback: 'Test feedback line.'
    }
  }
}

describe('studio merge patch', () => {
  it('keeps the synthetic fixture valid', () => {
    expect(validateDraft('test-pack', testDraft())).toEqual([])
  })

  it('preserves private instructions and removes them with a merge patch when cleared', () => {
    const pristine = testDraft()
    pristine.card.privateInstructions = 'A fictional private direction.'
    const draft = structuredClone(pristine)
    delete draft.card.privateInstructions
    expect(diffDocs(pristine, draft).patch).toEqual({ card: { privateInstructions: null } })
    expect(applyStudioPatch(pristine, diffDocs(pristine, draft).patch)).toEqual(draft)
  })

  it('sends only the leaves that changed', () => {
    const pristine = testDraft()
    const draft = testDraft()
    draft.moods.moods.calm.tone = 'Softer than before.'
    const { patch, changed } = diffDocs(pristine, draft)
    expect(changed).toEqual(['moods'])
    expect(patch).toEqual({ moods: { moods: { calm: { tone: 'Softer than before.' } } } })
  })

  it('tombstones a deleted mood and face group', () => {
    const pristine = testDraft()
    const draft = testDraft()
    delete draft.moods.moods.brisk
    if (draft.moods.faceGroups) delete draft.moods.faceGroups.soft
    const { patch, changed } = diffDocs(pristine, draft)
    expect(changed).toEqual(['moods'])
    expect(patch).toEqual({ moods: { moods: { brisk: null }, faceGroups: { soft: null } } })
    const applied = applyStudioPatch(pristine, patch)
    expect(applied).toEqual(draft)
    expect(applied.moods.moods.brisk).toBeUndefined()
  })

  it('tombstones a removed optional line and footer label', () => {
    const pristine = testDraft()
    const draft = testDraft()
    delete draft.lines.feedback
    if (draft.card.toolFooter?.labels) delete draft.card.toolFooter.labels.search
    const { patch, changed } = diffDocs(pristine, draft)
    expect(changed).toEqual(['card', 'lines'])
    expect(patch.lines).toEqual({ feedback: null })
    expect(patch.card).toEqual({ toolFooter: { labels: { search: null } } })
    expect(applyStudioPatch(pristine, patch)).toEqual(draft)
  })

  it('replaces arrays wholesale', () => {
    const pristine = testDraft()
    const draft = testDraft()
    draft.moods.moods.calm.openers = ['Hey there.', 'Oh hey.']
    const { patch } = diffDocs(pristine, draft)
    expect(patch).toEqual({ moods: { moods: { calm: { openers: ['Hey there.', 'Oh hey.'] } } } })
  })

  it('reports no changes for identical drafts', () => {
    const { patch, changed } = diffDocs(testDraft(), testDraft())
    expect(changed).toEqual([])
    expect(patch).toEqual({})
  })
})

describe('studio conflict compare', () => {
  it('merges concurrent unrelated edits without replaying stale fields', () => {
    const pristine = testDraft()
    const mine = testDraft()
    mine.moods.moods.calm.tone = 'My softer tone.'
    const theirs = testDraft()
    theirs.card.displayName = 'Their Name'
    theirs.moods.moods.soft = { ...testDraft().moods.moods.calm, tone: 'A third mood.' }
    const sets = compareDrafts(pristine, mine, theirs)
    expect(sets.overlapping).toEqual([])
    expect(sets.localOnly.map((leaf) => leaf.path)).toEqual(['moods.moods.calm.tone'])
    expect(sets.remoteOnly.map((leaf) => leaf.path)).toEqual(['card.displayName', 'moods.moods.soft'])
    const expected = testDraft()
    expected.card.displayName = 'Their Name'
    expected.moods.moods.soft = { ...testDraft().moods.moods.calm, tone: 'A third mood.' }
    expected.moods.moods.calm.tone = 'My softer tone.'
    expect(rebaseLeaves(theirs, sets.localOnly)).toEqual(expected)
  })

  it('partitions overlapping leaves for an explicit decision', () => {
    const pristine = testDraft()
    const mine = testDraft()
    mine.moods.moods.calm.tone = 'Mine.'
    mine.moods.moods.calm.endings = ['Later.']
    const theirs = testDraft()
    theirs.moods.moods.calm.tone = 'Theirs.'
    theirs.card.displayName = 'Their Name'
    const sets = compareDrafts(pristine, mine, theirs)
    expect(sets.overlapping).toEqual(['moods.moods.calm.tone'])
    expect(sets.localOnly.map((leaf) => leaf.path)).toEqual(['moods.moods.calm.endings'])
    expect(sets.remoteOnly.map((leaf) => leaf.path)).toEqual(['card.displayName'])
    const rebased = rebaseLeaves(theirs, sets.localOnly)
    expect(rebased.moods.moods.calm.tone).toBe('Theirs.')
    expect(rebased.moods.moods.calm.endings).toEqual(['Later.'])
    const decided = rebaseLeaves(
      rebased,
      sets.local.filter((leaf) => leaf.path === 'moods.moods.calm.tone')
    )
    expect(decided.moods.moods.calm.tone).toBe('Mine.')
  })

  it('lists deletions as leaves for the compare view', () => {
    const pristine = testDraft()
    const mine = testDraft()
    delete mine.moods.moods.brisk
    const leaves = listLeafChanges(pristine, mine)
    expect(leaves).toHaveLength(1)
    expect(leaves[0]!.path).toBe('moods.moods.brisk')
    expect('after' in leaves[0]!).toBe(true)
    expect(leaves[0]!.after).toBeUndefined()
    expect(leaves[0]!.before).toEqual(pristine.moods.moods.brisk)
  })
})

describe('studio save request', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('puts a merge patch of only the changed leaves', async () => {
    const seen: { url: string; body: string }[] = []
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
    vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
      seen.push({ url: String(url), body: String(init?.body) })
      return new Response(JSON.stringify({ revision: 'abc123' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    const pristine = testDraft()
    const draft = testDraft()
    draft.moods.moods.calm.tone = 'Softer than before.'
    const { patch } = diffDocs(pristine, draft)
    const answer = await putStudio('test-pack', 'rev-1', patch)
    expect(answer).toEqual({ revision: 'abc123' })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe('/owner-api/core/characters/test-pack/studio')
    const body = JSON.parse(seen[0]!.body) as { expectedRevision: string; patch: unknown }
    expect(body.expectedRevision).toBe('rev-1')
    expect(body.patch).toEqual({ moods: { moods: { calm: { tone: 'Softer than before.' } } } })
  })
})
