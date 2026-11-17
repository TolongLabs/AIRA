import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LINK_FIRST_SEGMENT_SECONDS,
  DEFAULT_LINK_SEGMENT_SECONDS,
  DEFAULT_MAX_LINK_SEGMENTS,
  MERGED_DESCRIPTION_CHARS,
  MERGED_TRANSCRIPT_CHARS,
  mergeLinkReadings,
  planLinkSegments
} from '../../src/media/link-segments.js'

const defaults = {
  maxLinkVideoSeconds: 600,
  firstSegmentSeconds: DEFAULT_LINK_FIRST_SEGMENT_SECONDS,
  segmentSeconds: DEFAULT_LINK_SEGMENT_SECONDS,
  maxSegments: DEFAULT_MAX_LINK_SEGMENTS
}

describe('planLinkSegments', () => {
  it('plans a 600 s span as 0–60, 60–240, 240–420, 420–600', () => {
    expect(planLinkSegments({ durationSec: 600, startSec: 0, ...defaults })).toEqual({
      segments: [
        { startSec: 0, endSec: 60 },
        { startSec: 60, endSec: 240 },
        { startSec: 240, endSec: 420 },
        { startSec: 420, endSec: 600 }
      ],
      clipped: false,
      unknownLength: false
    })
  })

  it('plans one segment when the span fits in linkSegmentSeconds', () => {
    expect(planLinkSegments({ durationSec: 120, startSec: 0, ...defaults })).toEqual({
      segments: [{ startSec: 0, endSec: 120 }],
      clipped: false,
      unknownLength: false
    })
    expect(planLinkSegments({ durationSec: 180, startSec: 0, ...defaults })).toEqual({
      segments: [{ startSec: 0, endSec: 180 }],
      clipped: false,
      unknownLength: false
    })
  })

  it('joins a last segment under 30 s to the one before', () => {
    expect(planLinkSegments({ durationSec: 440, startSec: 0, ...defaults })).toEqual({
      segments: [
        { startSec: 0, endSec: 60 },
        { startSec: 60, endSec: 240 },
        { startSec: 240, endSec: 440 }
      ],
      clipped: false,
      unknownLength: false
    })
    expect(planLinkSegments({ durationSec: 450, startSec: 0, ...defaults })).toEqual({
      segments: [
        { startSec: 0, endSec: 60 },
        { startSec: 60, endSec: 240 },
        { startSec: 240, endSec: 420 },
        { startSec: 420, endSec: 450 }
      ],
      clipped: false,
      unknownLength: false
    })
  })

  it('plans from the t= start and marks a longer video clipped', () => {
    expect(planLinkSegments({ durationSec: 1500, startSec: 90, ...defaults })).toEqual({
      segments: [
        { startSec: 90, endSec: 150 },
        { startSec: 150, endSec: 330 },
        { startSec: 330, endSec: 510 },
        { startSec: 510, endSec: 690 }
      ],
      clipped: true,
      unknownLength: false
    })
  })

  it('keeps at most maxLinkSegments and marks the rest clipped', () => {
    expect(planLinkSegments({ durationSec: 600, startSec: 0, ...defaults, maxSegments: 2 })).toEqual({
      segments: [
        { startSec: 0, endSec: 60 },
        { startSec: 60, endSec: 240 }
      ],
      clipped: true,
      unknownLength: false
    })
    expect(planLinkSegments({ durationSec: 700, startSec: 0, ...defaults, maxLinkVideoSeconds: 1000 })).toEqual({
      segments: [
        { startSec: 0, endSec: 60 },
        { startSec: 60, endSec: 240 },
        { startSec: 240, endSec: 420 },
        { startSec: 420, endSec: 600 }
      ],
      clipped: true,
      unknownLength: false
    })
  })

  it('plans one segment from the start offset when the length is unknown', () => {
    expect(planLinkSegments({ durationSec: null, startSec: 30, ...defaults })).toEqual({
      segments: [{ startSec: 30, endSec: 210 }],
      clipped: false,
      unknownLength: true
    })
  })

  it('starts at 0 when the start offset is past the end', () => {
    expect(planLinkSegments({ durationSec: 120, startSec: 150, ...defaults })).toEqual({
      segments: [{ startSec: 0, endSec: 120 }],
      clipped: false,
      unknownLength: false
    })
    expect(planLinkSegments({ durationSec: 120, startSec: 120, ...defaults })).toEqual({
      segments: [{ startSec: 0, endSec: 120 }],
      clipped: false,
      unknownLength: false
    })
  })
})

describe('mergeLinkReadings', () => {
  it('merges answered segments in order under clock labels with equal shares', () => {
    const plan = planLinkSegments({ durationSec: 600, startSec: 0, ...defaults })
    const longText = (tag: string) => `${tag} ` + 'word '.repeat(300)
    const merged = mergeLinkReadings(
      plan,
      [
        { description: longText('seg1'), transcript: longText('tr1') },
        { description: 'Second part.' },
        { description: longText('seg3'), transcript: longText('tr3') },
        { description: 'Fourth part.' }
      ],
      600
    )

    expect(merged).toBeDefined()
    const descShare = Math.floor(MERGED_DESCRIPTION_CHARS / 4)
    const transcriptShare = Math.floor(MERGED_TRANSCRIPT_CHARS / 2)
    expect(merged?.description).toContain('[0:00–1:00] seg1 ')
    expect(merged?.description).toContain('[1:00–4:00] Second part.')
    expect(merged?.description).toContain('[4:00–7:00] seg3 ')
    expect(merged?.description).toContain('[7:00–10:00] Fourth part.')
    const seg1Match = /\[0:00–1:00\] (.*?) \[1:00–4:00\]/.exec(merged!.description)
    expect(seg1Match?.[1]?.length).toBeLessThanOrEqual(descShare)
    expect(seg1Match?.[1]).toMatch(/word…$/)

    expect(merged?.transcript).toContain('[0:00] tr1 ')
    expect(merged?.transcript).toContain('[4:00] tr3 ')
    const tr1Match = /\[0:00\] (.*?) \[4:00\]/.exec(merged!.transcript!)
    expect(tr1Match?.[1]?.length).toBeLessThanOrEqual(transcriptShare)
    expect(tr1Match?.[1]).toMatch(/word…$/)
  })

  it('names the parts not watched in the coverage line', () => {
    const unclippedPlan = planLinkSegments({ durationSec: 600, startSec: 0, ...defaults })
    const unclippedMerged = mergeLinkReadings(
      unclippedPlan,
      [{ description: 'Intro.' }, { description: 'Middle.' }, undefined, { description: 'Ending.' }],
      600
    )
    expect(unclippedMerged?.description).toBe(
      'Not watched: 4:00–7:00. [0:00–1:00] Intro. [1:00–4:00] Middle. [7:00–10:00] Ending.'
    )

    const clippedPlan = planLinkSegments({ durationSec: 1500, startSec: 0, ...defaults })
    const clippedMerged = mergeLinkReadings(
      clippedPlan,
      [{ description: 'Intro.' }, undefined, undefined, { description: 'Last.' }],
      1500
    )
    expect(clippedMerged?.description).toBe(
      'Not watched: 1:00–4:00, 4:00–7:00. Covers only the first part (0:00–10:00 of 25:00): [0:00–1:00] Intro. [7:00–10:00] Last.'
    )

    const unknownPlan = planLinkSegments({ durationSec: null, startSec: 30, ...defaults })
    const unknownMerged = mergeLinkReadings(unknownPlan, [{ description: 'Clip.' }], null)
    expect(unknownMerged?.description).toBe("Covers only 0:30–3:30; the video's length is unknown: [0:30–3:30] Clip.")

    const singlePlan = planLinkSegments({ durationSec: 120, startSec: 0, ...defaults })
    expect(mergeLinkReadings(singlePlan, [{ description: 'Whole video.' }], 120)).toEqual({
      description: 'Whole video.'
    })
  })

  it('leaves the transcript out when no segment has one', () => {
    const plan = planLinkSegments({ durationSec: 600, startSec: 0, ...defaults })
    const merged = mergeLinkReadings(
      plan,
      [{ description: 'One.' }, { description: 'Two.' }, { description: 'Three.' }, { description: 'Four.' }],
      600
    )
    expect(merged).toBeDefined()
    expect('transcript' in merged!).toBe(false)
    expect(merged?.transcript).toBeUndefined()
  })
})
