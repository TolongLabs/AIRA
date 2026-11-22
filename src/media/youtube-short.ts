import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkedFetcher } from '../social/fetch.js'
import { sharePendingDownloads } from '../social/shared-download.js'
import { isolatedEnvironment } from '../social/yt-dlp.js'
import { isMp4 } from './video-compression.js'

export type ShortDownload = (
  id: string,
  signal: AbortSignal,
  maxBytes: number
) => Promise<{ data: Buffer; contentType: string }>

export async function confirmsShort(url: string, signal: AbortSignal, fetcher: typeof fetch): Promise<boolean> {
  const response = await fetcher(url, { signal, redirect: 'manual' })
  const reader = response.body?.getReader()
  if (!reader) return false
  try {
    if (response.status !== 200 || !response.headers.get('content-type')?.includes('text/html')) return false
    const decoder = new TextDecoder()
    let head = ''
    let bytes = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return false
      bytes += value.length
      if (bytes > 2_000_000) return false
      head += decoder.decode(value, { stream: true })
      const canonical = head.match(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i)
      if (canonical) return canonical[1] === url
      if (head.includes('</head>')) return false
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
}

export function createShortDownload(binary: string): ShortDownload {
  const fetcher = checkedFetcher(fetch)
  return sharePendingDownloads(async (id, signal, maxBytes) => {
    if (!/^[\w-]{11}$/.test(id)) throw Error('invalid Short ID')
    const url = 'https://www.youtube.com/shorts/' + id
    if (!(await confirmsShort(url, signal, fetcher))) throw Error('unconfirmed Short')
    const dir = await mkdtemp(join(tmpdir(), 'aira-short-'))
    try {
      signal.throwIfAborted()
      // Emit a fragmented MP4 to stdout so the byte cap applies during transfer, including muxed tracks.
      const args = [
        '--ignore-config',
        '--no-plugin-dirs',
        '--no-cache-dir',
        '--no-playlist',
        '--quiet',
        '--no-warnings',
        '--retries',
        '0',
        '--socket-timeout',
        '8',
        '--js-runtimes',
        'node',
        '--match-filter',
        'live_status = not_live & !is_live & duration > 0 & duration <= 180 & id = ' + id,
        '-f',
        'b[ext=mp4][vcodec^=avc][acodec^=mp4a]/bv[ext=mp4][vcodec^=avc][height<=720]+ba[ext=m4a]',
        '--downloader',
        'ffmpeg',
        '--downloader-args',
        'ffmpeg_o:-f mp4 -movflags frag_keyframe+empty_moov',
        '-o',
        '-',
        '--',
        url
      ]
      const data = await new Promise<Buffer>((resolve, reject) => {
        const child = spawn(binary, args, {
          cwd: dir,
          env: isolatedEnvironment(dir),
          detached: true,
          stdio: ['ignore', 'pipe', 'ignore']
        })
        const chunks: Buffer[] = []
        let size = 0
        const stop = () => {
          if (child.pid) {
            try {
              process.kill(-child.pid, 'SIGKILL')
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL')
            }
          }
        }
        signal.addEventListener('abort', stop, { once: true })
        child.stdout.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > maxBytes) stop()
          else chunks.push(chunk)
        })
        child.once('error', reject)
        child.once('close', (code) => {
          signal.removeEventListener('abort', stop)
          if (code !== 0 || signal.aborted || size > maxBytes || size === 0) reject(Error('Short download failed'))
          else resolve(Buffer.concat(chunks, size))
        })
      })
      if (!isMp4(data)) throw Error('invalid Short MP4')
      return { data, contentType: 'video/mp4' }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}
