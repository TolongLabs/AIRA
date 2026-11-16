import { describe, expect, it } from 'vitest'
import { renderDirect } from '../../src/tools/commands.js'

// Direct command answers in plain words (docs/trd/tools.md#direct-command-answers).
const ok = (data: unknown) => ({ ok: true as const, data })
const tz = { timeZone: 'Asia/Kuala_Lumpur' }

describe('direct command answers', () => {
  it('lists commands with their descriptions', () => {
    const text = renderDirect(
      'help',
      ok({ commands: [{ command: '/remind', usage: '/remind', description: 'Sets a reminder.' }] }),
      tz
    )
    expect(text).toBe('Commands in this chat:\n- **/remind** Sets a reminder.')
  })

  it('names tools and features in words, never as ids', () => {
    const text = renderDirect(
      'list',
      ok({ tools: ['web_search', 'reminder_set'], features: { 'features.search': true, 'features.voice': false } }),
      tz
    )
    expect(text).toBe('Tools on here: web search, reminder set.\nFeatures on: search. Off: voice.')
  })

  it('shows reminders in local time, with the repeat and who set it, and no id or UTC stamp', () => {
    const text = renderDirect(
      'reminder_list',
      ok({
        reminders: [
          { reminderId: 'rem_5efd685dc13e', dueAt: '2026-11-20T10:00:00.000Z', text: 'Buy cake.', mine: true },
          {
            reminderId: 'rem_x',
            dueAt: '2026-11-18T01:00:00.000Z',
            text: 'Call the bank',
            repeat: 'daily',
            mine: false
          }
        ]
      }),
      tz
    )
    expect(text).toBe(
      'Reminders in this chat:\n1. Buy cake, Fri 20 Nov, 6:00 pm\n2. Call the bank, Wed 18 Nov, 9:00 am, every day (set by someone else)'
    )
    expect(text).not.toMatch(/rem_|T\d\d:|Z\b/)
    expect(renderDirect('reminder_list', ok({ reminders: [] }), tz)).toBe('No reminders in this chat.')
  })
})
