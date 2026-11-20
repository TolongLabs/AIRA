// The SerpApi reverse-image client (docs/trd/tools.md#reverse-image-hints). A local picture is uploaded for an image id,
// then Google Lens searches by that id. A public photo URL is searched directly. Every match is untrusted and unverified.

const SERPAPI_IMAGE_URL = 'https://serpapi.com/image'
const SERPAPI_SEARCH_URL = 'https://serpapi.com/search'
const MAX_MATCHES = 5
const MAX_TITLE_CHARS = 200
const MAX_PRICE_CHARS = 40
/** The most a local picture may weigh to be uploaded. Config and the tool both cap at this. */
export const MAX_UPLOAD_BYTES = 500_000
/** The longest the upload and search may take together. Config and the tool both cap at this. */
export const MAX_TIMEOUT_MS = 6_000
/** The picture types the Image API accepts, with their file extensions. Any other type is never uploaded. */
const UPLOAD_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
}

/** True for a picture type the Image API accepts. */
export function isUploadType(contentType: string): boolean {
  return UPLOAD_EXTENSIONS[contentType] !== undefined
}

export interface IdentifyMatch {
  title: string
  /** The host of the match's https link, without `www.`. */
  domain: string
  link: string
  /** The price Lens gives, as written, when it gives one. */
  price?: string
}

export interface IdentifyPort {
  /** Uploads one picture, then searches Google Lens by the image id the upload returns. */
  byFile(data: Buffer, contentType: string, signal: AbortSignal): Promise<IdentifyMatch[]>
  /** Searches Google Lens by a public image URL. */
  byUrl(url: string, signal: AbortSignal): Promise<IdentifyMatch[]>
}

/** A provider failure. Its message is fixed text: never the key, a path, a URL or the provider's body. */
export class IdentifyError extends Error {}

type Record_ = Record<string, unknown>

function isRecord(value: unknown): value is Record_ {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The host of an https link without `www.`, or undefined for any other link. */
function domainOf(link: string): string | undefined {
  try {
    const url = new URL(link)
    if (url.protocol !== 'https:') return undefined
    return url.hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return undefined
  }
}

function parseMatches(body: unknown): IdentifyMatch[] {
  if (!isRecord(body) || !Array.isArray(body.visual_matches)) return []
  const matches: IdentifyMatch[] = []
  for (const item of body.visual_matches) {
    if (matches.length === MAX_MATCHES) break
    if (!isRecord(item) || typeof item.title !== 'string' || typeof item.link !== 'string') continue
    const title = item.title.trim().slice(0, MAX_TITLE_CHARS)
    const domain = domainOf(item.link)
    if (title === '' || domain === undefined) continue
    const priceValue = isRecord(item.price) ? item.price.value : undefined
    const price = typeof priceValue === 'string' ? priceValue.trim().slice(0, MAX_PRICE_CHARS) : ''
    matches.push({ title, domain, link: item.link, ...(price === '' ? {} : { price }) })
  }
  return matches
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new IdentifyError('provider refused the request')
  try {
    return await response.json()
  } catch {
    throw new IdentifyError('provider answered without JSON')
  }
}

export function createSerpApiIdentify(options: { apiKey: string; fetch?: typeof fetch }): IdentifyPort {
  const doFetch = options.fetch ?? fetch

  async function search(params: Record<string, string>, signal: AbortSignal): Promise<IdentifyMatch[]> {
    const url = new URL(SERPAPI_SEARCH_URL)
    url.searchParams.set('engine', 'google_lens')
    url.searchParams.set('type', 'visual_matches')
    url.searchParams.set('api_key', options.apiKey)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    return parseMatches(await readJson(await doFetch(url, { signal })))
  }

  return {
    async byFile(data, contentType, signal) {
      const extension = UPLOAD_EXTENSIONS[contentType]
      if (extension === undefined) throw new IdentifyError('unsupported picture type')
      const form = new FormData()
      form.append('api_key', options.apiKey)
      form.append('image', new Blob([new Uint8Array(data)], { type: contentType }), `photo.${extension}`)
      const body = await readJson(await doFetch(SERPAPI_IMAGE_URL, { method: 'POST', body: form, signal }))
      const imageId = isRecord(body) ? body.image_id : undefined
      if (typeof imageId !== 'string' || imageId === '') throw new IdentifyError('upload gave no image id')
      return search({ image_id: imageId }, signal)
    },
    byUrl(url, signal) {
      return search({ url }, signal)
    }
  }
}
