import { mkdir, writeFile } from 'node:fs/promises'
import { createExaSearchPort } from '../src/tools/exa.js'
import { type SearchCase, searchCases } from './search-cases.js'

const directory = new URL('../tests/fixtures/search/', import.meta.url)
const apiKey = process.env['EXA_API_KEY']
if (!apiKey) throw new Error('Set EXA_API_KEY before recording.')

type Result = { title?: string; url?: string; highlights?: string[] }

function keepPublicResults(payload: { results?: Result[] }, item: SearchCase) {
  const { host } = item
  return {
    results: (payload.results ?? []).flatMap((result) => {
      if (typeof result.url !== 'string') return []
      const url = new URL(result.url)
      if (url.hostname !== host && !url.hostname.endsWith(`.${host}`)) return []
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return []
      if (item.id === 'measurement' && !url.pathname.includes('cleaning-and-repair')) return []
      if (
        item.id === 'hardware-price' &&
        !/\/(?:new-raspberry-pi-zero|meet-raspberry-pi-zero|products)/.test(url.pathname)
      )
        return []
      url.search = ''
      url.hash = ''
      const excerpt = result.highlights?.find((text) => typeof text === 'string' && text.trim())
      const publicExcerpt = excerpt?.replace(/^Written By\n:[^\n]*\n/gm, '').slice(0, 650)
      return [{ title: result.title, url: url.href, highlights: publicExcerpt ? [publicExcerpt] : [] }]
    })
  }
}

async function record(item: SearchCase) {
  const payloads: Record<string, ReturnType<typeof keepPublicResults>> = {}
  const port = createExaSearchPort({
    apiKey: apiKey!,
    fetch: async (input, init) => {
      const { query } = JSON.parse(String(init?.body)) as { query: string }
      const response = await fetch(input, init)
      if (response.ok)
        payloads[query] = keepPublicResults((await response.clone().json()) as { results?: Result[] }, item)
      return response
    }
  })
  for (const query of [item.query, item.localQuery]) await port.search(query, AbortSignal.timeout(10_000))
  if (!Object.values(payloads).some(({ results }) => results.length > 0)) {
    throw new Error(`No public results recorded for ${item.id}`)
  }
  const recording = { ...item, recordedAt: new Date().toISOString().slice(0, 10), payloads }
  await writeFile(new URL(`${item.id}.json`, directory), `${JSON.stringify(recording, null, 2)}\n`)
  console.log(
    item.id,
    Object.values(payloads)
      .map(({ results }) => results.length)
      .join('/')
  )
}

await mkdir(directory, { recursive: true })
for (const item of searchCases) {
  if (!process.argv[2] || process.argv[2] === item.id) await record(item)
}
