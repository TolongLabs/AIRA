import { describe, expect, it, vi } from 'vitest'
import { createSearchDepth, passageMatches } from '../../src/tools/search-depth.js'
import { createTurnSources } from '../../src/turn/sources.js'

const sourceUrl = 'https://cafe.example/menu'
const fields = [{ kind: 'price' as const, subject: 'Oat latte' }]
const query = 'oat latte price'
const localQuery = 'harga oat latte'
const menu = { title: 'Oat latte at the café', url: sourceUrl, snippet: 'See our seasonal drinks.' }

function context() {
  return {
    callId: 'search-1',
    sources: createTurnSources(),
    deadline: Date.now() + 30_000,
    callDeadline: Date.now() + 15_000,
    now: () => new Date(),
    signal: new AbortController().signal
  }
}

describe('search field evidence', () => {
  it('requires three distinct named list items', () => {
    const field = { kind: 'list', subject: 'Breakfast menu' } as const
    expect(passageMatches(field, 'Options include an oat latte, a flat white, and a vanilla mocha.')).toBe(true)
    expect(passageMatches(field, '- Oat latte\n- Oat latte\n- Flat white')).toBe(false)
    expect(passageMatches(field, '- ### Hot Coffee\n- ### Cold Coffee\n- ### Breakfast')).toBe(false)
    expect(passageMatches(field, 'Menu; Food; Drinks')).toBe(false)
  })

  it('ignores size labels of any brand and accepts named lists outside food', () => {
    const field = { kind: 'list', subject: 'Drink sizes' } as const
    expect(passageMatches(field, '- Small\n- Medium\n- Large')).toBe(false)
    expect(passageMatches(field, '- Short\n- Tall\n- Grande')).toBe(false)
    expect(passageMatches(field, '- Short (8 fl oz)\n- Tall (12 fl oz)\n- Grande (16 fl oz)')).toBe(false)
    expect(passageMatches(field, '- Small 250 ml\n- Medium 350 ml\n- Large 500 ml')).toBe(false)
    expect(passageMatches(field, '- Short (8 fl. oz.)\n- Tall (12 fl. oz.)\n- Grande (16 fl. oz.)')).toBe(false)
    expect(
      passageMatches(field, '- Short (8 fl oz / 236 ml)\n- Tall (12 fl oz / 355 ml)\n- Grande (16 fl oz / 473 ml)')
    ).toBe(false)
    const phones = { kind: 'list', subject: 'Phone models' } as const
    expect(passageMatches(phones, '- Example One\n- Example One Pro\n- Example Air')).toBe(true)
  })

  it('requires a currency and amount close to the named item', () => {
    expect(passageMatches(fields[0]!, 'An oat latte costs RM12.50.')).toBe(true)
    expect(passageMatches(fields[0]!, 'An oat latte costs 12.50.')).toBe(false)
    expect(passageMatches(fields[0]!, `An oat latte. ${'Elsewhere. '.repeat(12)} An espresso is RM 8.`)).toBe(false)
    expect(passageMatches({ ...fields[0]!, aliases: ['燕麦拿铁'] }, '燕麦拿铁 价格 30元')).toBe(true)
  })

  it('requires the subject and time in one passage for hours, and every subject word for other facts', () => {
    const hours = { kind: 'hours' as const, subject: 'Flower Dome' }
    expect(passageMatches(hours, 'Flower Dome opens from 9 am to 9 pm.')).toBe(true)
    expect(passageMatches(hours, 'Cloud Forest opens from 09:00 to 21:00.')).toBe(false)
    expect(passageMatches(hours, 'Flower Dome opens daily.')).toBe(false)
    const other = { kind: 'other' as const, subject: 'Merlion height' }
    expect(passageMatches(other, 'The height of the Merlion is 8.6 metres.')).toBe(true)
    expect(passageMatches(other, 'The Merlion is at the park.')).toBe(false)
  })
})

describe('search depth', () => {
  it('keeps size lines whole without bullets and long prose split at sentences beside a bullet', async () => {
    const depth = (snippet: string, field: { kind: 'list' | 'other' | 'price'; subject: string }) =>
      createSearchDepth(
        { search: { search: vi.fn(async () => [{ title: 't', url: 'https://cafe.example/p', snippet }]) } },
        { maxSearches: 1, maxPages: 0, maxProviderCalls: 1 }
      ).deep({ query: 'q', fields: [field] }, context())
    const sizes = await depth('Short (8 fl. oz.)\nTall (12 fl. oz.)\nGrande (16 fl. oz.)', {
      kind: 'list',
      subject: 'Drink sizes'
    })
    expect(sizes.brief.passages).toEqual([])
    for (const snippet of [
      'Short (8 Fl. Oz. / 236 ml)\nTall (12 Fl. Oz. / 355 ml)\nGrande (16 Fl. Oz. / 473 ml)',
      'Short (8 Fl. Oz.) RM 10\nTall (12 Fl. Oz.) RM 12\nGrande (16 Fl. Oz.) RM 14',
      'Short (8 Fl. Oz.)\nTall (12 Fl. Oz.)\nGrande (16 Fl. Oz.)'
    ]) {
      expect((await depth(snippet, { kind: 'list', subject: 'Drink sizes' })).brief.passages).toEqual([])
    }
    const bare = await depth('1.\n\nAn oat latte.\n\nTea RM 8.', { kind: 'price', subject: 'Oat latte' })
    expect(bare.brief.passages).toEqual([])
    const tabbed = await depth('1.\tEspresso\n\n2.\tLatte\n\n3.\tMocha', { kind: 'list', subject: 'Coffee' })
    expect(tabbed.brief.passages).toHaveLength(1)
    const prose = `- Home\n${'The park is open daily and well kept. '.repeat(20)}The Merlion has a total height of 8.6 metres.`
    const height = await depth(prose, { kind: 'other', subject: 'Merlion height' })
    expect(height.brief.passages.map((passage) => passage.text)).toEqual([
      expect.stringMatching(/^The park[\s\S]*The Merlion has a total height of 8\.6 metres\.$/)
    ])
    const numbered = await depth('1. iPhone 16\n2. Galaxy S25\n3. Pixel 9', {
      kind: 'list',
      subject: 'Example models'
    })
    expect(numbered.brief.passages).toHaveLength(1)
  })

  it('does not take size lines with abbreviated units for list items in a real search', async () => {
    const sizes = {
      title: 'Drink sizes',
      url: 'https://cafe.example/sizes',
      snippet: '- Short (8 fl. oz.)\n- Tall (12 fl. oz.)\n- Grande (16 fl. oz.)'
    }
    const { brief } = await createSearchDepth(
      { search: { search: vi.fn(async () => [sizes]) } },
      {
        maxSearches: 1,
        maxPages: 0,
        maxProviderCalls: 1
      }
    ).deep({ query: 'drink sizes', fields: [{ kind: 'list', subject: 'Drink sizes' }] }, context())
    expect(brief.passages).toEqual([])
  })

  it('reads a page whose result names a list before one that does not', async () => {
    const plain = { title: 'Example models', url: 'https://plain.example/a', snippet: 'Example news.' }
    const lineup = { title: 'Example models lineup', url: 'https://lineup.example/b', snippet: 'Example news.' }
    const read = vi.fn(async () => ({ title: '', text: '' }))
    await createSearchDepth(
      { search: { search: vi.fn(async () => [plain, lineup]) }, searchPage: { read } },
      {
        maxSearches: 1,
        maxPages: 1,
        maxProviderCalls: 2
      }
    ).deep({ query: 'example models', fields: [{ kind: 'list', subject: 'Example models' }] }, context())
    expect(read).toHaveBeenCalledWith(lineup.url, expect.any(AbortSignal))
  })

  it('skips a recognised LinkedIn candidate and reads the next eligible page', async () => {
    const linkedin = {
      title: 'Example models lineup',
      url: 'https://www.linkedin.com/posts/synthetic-update-activity-1234567890123456789',
      snippet: 'Example news.'
    }
    const eligible = { title: 'Example models', url: 'https://lineup.example/b', snippet: 'Example news.' }
    const read = vi.fn(async () => ({ title: '', text: '- Example One\n- Example Two\n- Example Three' }))
    const { brief } = await createSearchDepth(
      { search: { search: vi.fn(async () => [linkedin, eligible]) }, searchPage: { read } },
      {
        maxSearches: 1,
        maxPages: 2,
        maxProviderCalls: 3
      }
    ).deep({ query: 'example models', fields: [{ kind: 'list', subject: 'Example models' }] }, context())
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith(eligible.url, expect.any(AbortSignal))
    expect(brief.passages.map((passage) => passage.url)).toEqual([eligible.url])
  })

  it('fails the call when the provider fails the first search, without a retry', async () => {
    const search = vi.fn(async () => {
      throw new Error('http status 401')
    })
    await expect(
      createSearchDepth({ search: { search } }).deep({ query, localQuery, fields }, context())
    ).rejects.toThrow('http status 401')
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('keeps the first results when only the retry search fails', async () => {
    const twoFields = [...fields, { kind: 'other' as const, subject: 'seasonal drinks' }]
    const search = vi.fn().mockResolvedValueOnce([menu]).mockRejectedValueOnce(new Error('http status 429'))
    const { brief } = await createSearchDepth({ search: { search } }).deep(
      { query, localQuery, fields: twoFields },
      context()
    )
    expect(search).toHaveBeenCalledTimes(2)
    expect(brief.passages).toEqual([{ source: 's1', url: sourceUrl, text: 'See our seasonal drinks.' }])
    expect(brief.stillMissing).toBe('Still missing: Oat latte (price).')
  })

  it('makes only the first search when its snippet covers every field', async () => {
    const search = vi.fn(async () => [{ ...menu, snippet: 'Oat latte RM 14.' }])
    const read = vi.fn(async () => ({ title: '', text: '' }))
    const brief = await createSearchDepth({ search: { search }, searchPage: { read } }).deep(
      { query, localQuery, fields },
      context()
    )

    expect(search).toHaveBeenCalledTimes(1)
    expect(read).not.toHaveBeenCalled()
    expect(brief.brief).toEqual({
      passages: [{ url: sourceUrl, source: 's1', text: 'Oat latte RM 14.' }],
      stillMissing: 'Still missing: none.'
    })
  })

  it('retries in the requested language, then reads a ranked page and taints the turn', async () => {
    const search = vi.fn(async () => [
      { title: 'Unrelated price', url: 'https://cafe.example/soda', snippet: 'RM 9.' },
      { title: 'Local service', url: 'http://127.0.0.1/menu', snippet: 'Oat latte RM 14.' },
      menu
    ])
    const read = vi.fn(async () => ({ title: '', text: 'Oat latte RM 14.00.' }))
    const ctx = context()
    const tool = createSearchDepth({ search: { search }, searchPage: { read } })
    const brief = await tool.deep({ query, localQuery, fields }, ctx)

    expect(search.mock.calls).toHaveLength(2)
    expect(search).toHaveBeenNthCalledWith(1, query, expect.any(AbortSignal))
    expect(search).toHaveBeenNthCalledWith(2, localQuery, expect.any(AbortSignal))
    expect(read).toHaveBeenCalledExactlyOnceWith(sourceUrl, expect.any(AbortSignal))
    expect(brief.brief.passages[0]).toMatchObject({ url: sourceUrl, source: 's3' })
    expect(ctx.sources.readThisTurn()).toBe(true)
    expect(ctx.sources.find({ source: 's3' })).toMatchObject({ url: sourceUrl })

    const next = await tool.deep({ query, localQuery, fields }, { ...ctx, callId: 'search-2' })
    expect(next.brief.stillMissing).toBe('Still missing: Oat latte (price).')
    expect(search).toHaveBeenCalledTimes(2)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('caps page reads when it has provider budget for two of them', async () => {
    const search = vi.fn(async () =>
      ['one', 'two', 'three'].map((slug) => ({ ...menu, url: `https://cafe.example/${slug}` }))
    )
    const read = vi.fn(async () => ({ title: 'Oat latte RM 14', text: 'Drinks served daily.' }))
    const tool = createSearchDepth(
      { search: { search }, searchPage: { read } },
      { maxSearches: 1, maxPages: 2, maxProviderCalls: 3 }
    )
    const { brief } = await tool.deep({ query, localQuery, fields }, context())
    expect(search).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledTimes(2)
    expect(brief.passages).toEqual([])
    expect(brief.stillMissing).toBe('Still missing: Oat latte (price).')
  })

  it.each([
    ['turn', 4040, 15_000],
    ['tool', 30_000, 1540]
  ])('reserves reply time at the %s deadline even if a provider ignores abort', async (_, turnMs, toolMs) => {
    vi.useFakeTimers()
    try {
      const search = vi.fn(() => new Promise<never>(() => {}))
      const ctx = { ...context(), deadline: Date.now() + turnMs, callDeadline: Date.now() + toolMs }
      const pending = createSearchDepth({ search: { search } }).deep({ query, localQuery, fields }, ctx)
      await vi.advanceTimersByTimeAsync(40)
      const { brief } = await pending
      expect(brief.stillMissing).toBe('Still missing: Oat latte (price).')
      expect(search).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a plain query to one ordinary search with the same result format', async () => {
    const search = vi.fn(async () => [menu])
    const depthSearch = vi.fn(async () => [])
    const tool = createSearchDepth({ search: { search, depthSearch } })
    expect(await tool.plain(query, context())).toEqual([{ ...menu, source: 's1' }])
    expect(search).toHaveBeenCalledTimes(1)
    expect(depthSearch).not.toHaveBeenCalled()
  })
})
