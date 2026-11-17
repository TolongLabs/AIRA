import { spawn } from 'node:child_process'
import { access, copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ReportDocument, type ReportFormat, reportDocumentSchema, reportFormatSchema } from './types.js'

export const MAX_TYPST_OUTPUT_BYTES = 1024 * 1024

export type RenderErrorKind = 'invalid' | 'timeout' | 'too_large' | 'engine'

export class RenderError extends Error {
  override name = 'RenderError'
  constructor(
    readonly kind: RenderErrorKind,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}

export interface RenderRunOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  shell: false
  stdio: ['ignore', 'pipe', 'pipe']
}

export interface RenderProcess {
  readonly stdout?: NodeJS.ReadableStream | null
  readonly stderr?: NodeJS.ReadableStream | null
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

export type RenderRunner = (command: string, args: readonly string[], options: RenderRunOptions) => RenderProcess

export interface RenderReportOptions {
  typstPath: string
  timeoutMs: number
  maxPages: number
  maxBytes: number
  tmpDir?: string
  run?: RenderRunner
}

export function buildTypstArgs(rootDir: string): string[] {
  return ['compile', '--root', rootDir, '--input', 'data=data.json', 'report.typ', 'out.pdf']
}

export function countPdfPages(pdf: Buffer): number {
  const matches = pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)
  return matches?.length ?? 0
}

function isolatedEnvironment(dir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: dir,
    XDG_CACHE_HOME: dir,
    XDG_CONFIG_HOME: dir,
    TMPDIR: dir
  }
}

function formatIssuePaths(issues: readonly { path: readonly PropertyKey[] }[]): string {
  return issues.map((issue) => issue.path.map(String).join('.') || '(root)').join(', ')
}

async function resolveTemplatePath(): Promise<string> {
  const candidates = [
    fileURLToPath(new URL('./templates/report.typ', import.meta.url)),
    join(process.cwd(), 'src/render/templates/report.typ')
  ]
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Try next location when running from build output without copied templates.
    }
  }
  throw new RenderError('engine', 'report template not found')
}

function runTypst(typstPath: string, workDir: string, timeoutMs: number, runner?: RenderRunner): Promise<void> {
  const run: RenderRunner = runner ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions))
  return new Promise((resolve, reject) => {
    let settled = false
    let failure: { kind: RenderErrorKind; message: string } | null = null
    let outputBytes = 0
    let child: RenderProcess | null = null

    const finish = (error?: RenderError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }

    const timer = setTimeout(() => {
      if (!failure) failure = { kind: 'timeout', message: 'typst render timed out' }
      child?.kill('SIGKILL')
    }, timeoutMs)

    try {
      child = run(typstPath, buildTypstArgs(workDir), {
        cwd: workDir,
        env: isolatedEnvironment(workDir),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      finish(new RenderError('engine', 'typst failed to start'))
      return
    }

    const onOutput = (chunk: Buffer) => {
      outputBytes += chunk.byteLength
      if (outputBytes > MAX_TYPST_OUTPUT_BYTES && !failure) {
        failure = { kind: 'engine', message: 'typst output exceeded byte limit' }
        child?.kill('SIGKILL')
      }
    }

    child.stdout?.on('data', onOutput)
    child.stderr?.on('data', onOutput)

    child.once('error', (error: NodeJS.ErrnoException) => {
      finish(new RenderError('engine', error.code === 'ENOENT' ? 'typst binary not found' : 'typst failed to start'))
    })

    child.once('close', (code, signal) => {
      if (failure) {
        finish(new RenderError(failure.kind, failure.message))
        return
      }
      if (code !== 0) {
        const detail = code !== null ? `code ${code}` : `signal ${signal ?? 'unknown'}`
        finish(new RenderError('engine', `typst exited with ${detail}`))
        return
      }
      finish()
    })
  })
}

export async function renderReport(
  doc: ReportDocument,
  format: ReportFormat,
  options: RenderReportOptions
): Promise<{ pdf: Buffer; pages: number }> {
  if (
    options.typstPath.trim().length === 0 ||
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    !Number.isInteger(options.maxPages) ||
    options.maxPages <= 0 ||
    !Number.isInteger(options.maxBytes) ||
    options.maxBytes <= 0
  ) {
    throw new RenderError('invalid', 'invalid render options')
  }

  const parsedDoc = reportDocumentSchema.safeParse(doc)
  if (!parsedDoc.success) {
    throw new RenderError('invalid', `invalid report document: ${formatIssuePaths(parsedDoc.error.issues)}`)
  }

  const parsedFormat = reportFormatSchema.safeParse(format)
  if (!parsedFormat.success) {
    throw new RenderError('invalid', `invalid report format: ${formatIssuePaths(parsedFormat.error.issues)}`)
  }

  const templatePath = await resolveTemplatePath()
  const workDir = await mkdtemp(join(options.tmpDir ?? tmpdir(), 'aira-render-'))

  try {
    await writeFile(
      join(workDir, 'data.json'),
      JSON.stringify({ doc: parsedDoc.data, format: parsedFormat.data }),
      'utf8'
    )
    await copyFile(templatePath, join(workDir, 'report.typ'))
    await runTypst(options.typstPath, workDir, options.timeoutMs, options.run)

    const pdfPath = join(workDir, 'out.pdf')
    let fileStat: Awaited<ReturnType<typeof stat>>
    try {
      fileStat = await stat(pdfPath)
    } catch {
      throw new RenderError('engine', 'typst produced no output pdf')
    }

    if (fileStat.size > options.maxBytes) {
      throw new RenderError('too_large', `rendered pdf exceeds maxBytes (${fileStat.size} > ${options.maxBytes})`)
    }

    const pdf = await readFile(pdfPath)
    if (pdf.byteLength === 0) {
      throw new RenderError('engine', 'typst produced an empty pdf')
    }
    if (pdf.byteLength > options.maxBytes) {
      throw new RenderError('too_large', `rendered pdf exceeds maxBytes (${pdf.byteLength} > ${options.maxBytes})`)
    }

    const pages = countPdfPages(pdf)
    if (pages > options.maxPages) {
      throw new RenderError('too_large', `rendered pdf exceeds maxPages (${pages} > ${options.maxPages})`)
    }

    return { pdf, pages }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

export async function isTypstAvailable(typstPath: string, timeoutMs = 10_000): Promise<boolean> {
  if (typstPath.trim().length === 0) return false
  const dir = await mkdtemp(join(tmpdir(), 'aira-typst-check-'))
  try {
    return await new Promise<boolean>((resolve) => {
      let settled = false
      let child: ReturnType<typeof spawn> | null = null
      const finish = (available: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(available)
      }
      const timer = setTimeout(() => {
        child?.kill('SIGKILL')
        finish(false)
      }, timeoutMs)

      child = spawn(typstPath, ['--version'], {
        cwd: dir,
        env: isolatedEnvironment(dir),
        shell: false,
        stdio: 'ignore'
      })
      child.once('error', () => finish(false))
      child.once('close', (code) => finish(code === 0))
    })
  } catch {
    return false
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
