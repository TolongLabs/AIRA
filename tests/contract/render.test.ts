import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { loadConfig, parseConfig } from '../../src/config/loader.js'
import {
  MAX_TYPST_OUTPUT_BYTES,
  RenderError,
  type RenderProcess,
  type RenderRunOptions,
  type RenderRunner,
  countPdfPages,
  isTypstAvailable,
  renderNote,
  renderReport
} from '../../src/render/render.js'
import {
  type NoteDocument,
  type ReportDocument,
  type ReportFormat,
  reportDocumentSchema,
  reportFormatSchema
} from '../../src/render/types.js'
import { tmpDir } from '../support/tmp.js'

const sampleDoc = reportDocumentSchema.parse(JSON.parse(readFileSync('tests/fixtures/report/sample.json', 'utf8')))
const defaultFormat: ReportFormat = reportFormatSchema.parse({})

function fakePdf(pageCount: number, paddingBytes = 0): Buffer {
  const objects = ['<< /Type /Pages /Count ' + pageCount + ' >>']
  for (let i = 0; i < pageCount; i += 1) {
    objects.push('<< /Type /Page /Parent 1 0 R >>')
  }
  objects.push('<< /Type /PageLabels >>')
  const header = `%PDF-1.4\n${objects.join('\n')}\n`
  if (paddingBytes <= 0) return Buffer.from(header, 'latin1')
  return Buffer.concat([Buffer.from(header, 'latin1'), Buffer.alloc(paddingBytes, 0x20)])
}

function makeFakeProcess(): {
  proc: RenderProcess & EventEmitter
  stdout: PassThrough
  stderr: PassThrough
  killed: (NodeJS.Signals | number | undefined)[]
} {
  const emitter = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const killed: (NodeJS.Signals | number | undefined)[] = []
  const proc = Object.assign(emitter, {
    stdout,
    stderr,
    kill(signal?: NodeJS.Signals | number) {
      killed.push(signal)
      stdout.end()
      stderr.end()
      queueMicrotask(() => emitter.emit('close', null, typeof signal === 'string' ? signal : 'SIGKILL'))
      return true
    }
  })
  return { proc, stdout, stderr, killed }
}

function fakeExecutable(dir: string, name: string, scriptBody: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!${process.execPath}\n${scriptBody}\n`, 'utf8')
  chmodSync(path, 0o755)
  return path
}

describe('render config', () => {
  it('loads the repository render defaults and rejects unknown keys', () => {
    const config = loadConfig('config.yml')
    expect(config.render).toEqual({
      typstPath: 'typst',
      timeoutMs: 20000,
      maxPages: 30,
      maxBytes: 5242880,
      report: {
        pageSize: 'A4',
        accent: '#2f6fde',
        fontSize: 10.5,
        cover: true,
        sourcesAppendix: true,
        header: ''
      }
    })

    const source = readFileSync('config.yml', 'utf8')
    expect(() => parseConfig(source.replace("pageSize: 'A4'", "pageSize: 'A4'\n    extraKey: true"))).toThrow(
      /render\.report/
    )
  })
})

describe('countPdfPages', () => {
  it('counts /Type /Page objects and ignores /Type /Pages and /Type /PageLabels', () => {
    expect(countPdfPages(fakePdf(3))).toBe(3)
    expect(countPdfPages(Buffer.from('%PDF-1.4\n<< /Type /Pages >>\n<< /Type\n/Page>>\n', 'latin1'))).toBe(1)
  })
})

describe('renderReport', () => {
  it('stages data.json and template, passes safe argv without shell, and cleans up on success', async () => {
    const scratch = tmpDir()
    let seenCommand = ''
    let seenArgs: readonly string[] = []
    let seenOptions: RenderRunOptions | null = null
    let stagedFiles: string[] = []
    let stagedData: unknown = null
    let stagedTemplate = ''

    const run: RenderRunner = (command, args, options) => {
      seenCommand = command
      seenArgs = args
      seenOptions = options
      stagedFiles = readdirSync(options.cwd).sort()
      stagedData = JSON.parse(readFileSync(join(options.cwd, 'data.json'), 'utf8'))
      stagedTemplate = readFileSync(join(options.cwd, 'report.typ'), 'utf8')

      const { proc, stdout, stderr } = makeFakeProcess()
      writeFileSync(join(options.cwd, 'out.pdf'), fakePdf(2))
      stdout.end()
      stderr.end()
      queueMicrotask(() => proc.emit('close', 0, null))
      return proc
    }

    const result = await renderReport(sampleDoc, defaultFormat, {
      typstPath: 'typst',
      timeoutMs: 5000,
      maxPages: 30,
      maxBytes: 5_242_880,
      tmpDir: scratch,
      run
    })

    expect(seenCommand).toBe('typst')
    expect(seenOptions).not.toBeNull()
    expect(seenOptions!.shell).toBe(false)
    expect(seenArgs).toEqual([
      'compile',
      '--root',
      seenOptions!.cwd,
      '--input',
      'data=data.json',
      'report.typ',
      'out.pdf'
    ])
    expect(Object.keys(seenOptions!.env).sort()).toEqual([
      'HOME',
      'PATH',
      'TMPDIR',
      'XDG_CACHE_HOME',
      'XDG_CONFIG_HOME'
    ])
    expect(seenOptions!.env['HOME']).toBe(seenOptions!.cwd)
    expect(stagedFiles).toEqual(['data.json', 'report.typ'])
    expect(stagedData).toEqual({ doc: sampleDoc, format: defaultFormat })
    expect(stagedTemplate).toContain('json(sys.inputs.data)')
    expect(result.pages).toBe(2)
    expect(result.pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(readdirSync(scratch)).toEqual([])
  })

  it('kills a timed out process with SIGKILL and removes the temporary folder', async () => {
    const scratch = tmpDir()
    const { proc, killed } = makeFakeProcess()
    const run: RenderRunner = () => proc

    const promise = renderReport(sampleDoc, defaultFormat, {
      typstPath: 'typst',
      timeoutMs: 30,
      maxPages: 30,
      maxBytes: 5_242_880,
      tmpDir: scratch,
      run
    })

    await expect(promise).rejects.toSatisfy((err: unknown) => err instanceof RenderError && err.kind === 'timeout')
    expect(killed).toEqual(['SIGKILL'])
    expect(readdirSync(scratch)).toEqual([])
  })

  it('kills a real slow child process on timeout', async () => {
    const scratch = tmpDir()
    const binDir = join(scratch, 'bin')
    const workTmp = join(scratch, 'work')
    mkdirSync(binDir)
    mkdirSync(workTmp)
    const slowBin = fakeExecutable(binDir, 'slow-typst', 'setTimeout(() => process.exit(0), 5000)')

    await expect(
      renderReport(sampleDoc, defaultFormat, {
        typstPath: slowBin,
        timeoutMs: 50,
        maxPages: 30,
        maxBytes: 5_242_880,
        tmpDir: workTmp
      })
    ).rejects.toSatisfy((err: unknown) => err instanceof RenderError && err.kind === 'timeout')
    expect(readdirSync(workTmp)).toEqual([])
  })

  it('removes the temporary folder and omits document text when engine fails', async () => {
    const scratch = tmpDir()
    const canaryDoc: ReportDocument = {
      ...sampleDoc,
      summary: 'CANARY_SECRET_DOCUMENT_TEXT_12345'
    }
    const run: RenderRunner = () => {
      const { proc, stdout, stderr } = makeFakeProcess()
      stderr.write('typst error near CANARY_SECRET_DOCUMENT_TEXT_12345')
      stdout.end()
      stderr.end()
      queueMicrotask(() => proc.emit('close', 1, null))
      return proc
    }

    let caught: unknown = null
    try {
      await renderReport(canaryDoc, defaultFormat, {
        typstPath: 'typst',
        timeoutMs: 5000,
        maxPages: 30,
        maxBytes: 5_242_880,
        tmpDir: scratch,
        run
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(RenderError)
    expect((caught as RenderError).kind).toBe('engine')
    expect((caught as RenderError).message).not.toContain('CANARY_SECRET_DOCUMENT_TEXT_12345')
    expect(readdirSync(scratch)).toEqual([])
  })

  it('kills a runaway process that exceeds the output byte cap', async () => {
    const scratch = tmpDir()
    const { proc, stderr, killed } = makeFakeProcess()
    const run: RenderRunner = () => {
      queueMicrotask(() => {
        stderr.write(Buffer.alloc(MAX_TYPST_OUTPUT_BYTES + 1, 0x78))
      })
      return proc
    }

    await expect(
      renderReport(sampleDoc, defaultFormat, {
        typstPath: 'typst',
        timeoutMs: 5000,
        maxPages: 30,
        maxBytes: 5_242_880,
        tmpDir: scratch,
        run
      })
    ).rejects.toSatisfy((err: unknown) => err instanceof RenderError && err.kind === 'engine')
    expect(killed).toEqual(['SIGKILL'])
    expect(readdirSync(scratch)).toEqual([])
  })

  it('refuses PDFs exceeding maxPages or maxBytes and cleans up', async () => {
    const scratch = tmpDir()

    const tooManyPagesRunner: RenderRunner = (_cmd, _args, options) => {
      const { proc, stdout, stderr } = makeFakeProcess()
      writeFileSync(join(options.cwd, 'out.pdf'), fakePdf(4))
      stdout.end()
      stderr.end()
      queueMicrotask(() => proc.emit('close', 0, null))
      return proc
    }

    await expect(
      renderReport(sampleDoc, defaultFormat, {
        typstPath: 'typst',
        timeoutMs: 5000,
        maxPages: 3,
        maxBytes: 5_242_880,
        tmpDir: scratch,
        run: tooManyPagesRunner
      })
    ).rejects.toSatisfy((err: unknown) => err instanceof RenderError && err.kind === 'too_large')
    expect(readdirSync(scratch)).toEqual([])

    const tooManyBytesRunner: RenderRunner = (_cmd, _args, options) => {
      const { proc, stdout, stderr } = makeFakeProcess()
      writeFileSync(join(options.cwd, 'out.pdf'), fakePdf(1, 200))
      stdout.end()
      stderr.end()
      queueMicrotask(() => proc.emit('close', 0, null))
      return proc
    }

    await expect(
      renderReport(sampleDoc, defaultFormat, {
        typstPath: 'typst',
        timeoutMs: 5000,
        maxPages: 30,
        maxBytes: 120,
        tmpDir: scratch,
        run: tooManyBytesRunner
      })
    ).rejects.toSatisfy((err: unknown) => err instanceof RenderError && err.kind === 'too_large')
    expect(readdirSync(scratch)).toEqual([])
  })

  it('rejects invalid documents and formats without creating files or leaking document text', async () => {
    const scratch = tmpDir()
    let ran = false
    const run: RenderRunner = () => {
      ran = true
      return makeFakeProcess().proc
    }

    const badDoc = {
      ...sampleDoc,
      title: 'x',
      summary: 'CANARY_PRIVATE_SUMMARY_TEXT'
    } as ReportDocument

    let caught: unknown = null
    try {
      await renderReport(badDoc, defaultFormat, {
        typstPath: 'typst',
        timeoutMs: 5000,
        maxPages: 30,
        maxBytes: 5_242_880,
        tmpDir: scratch,
        run
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(RenderError)
    expect((caught as RenderError).kind).toBe('invalid')
    expect((caught as RenderError).message).not.toContain('CANARY_PRIVATE_SUMMARY_TEXT')
    expect(ran).toBe(false)
    expect(readdirSync(scratch)).toEqual([])

    const badFormat = { ...defaultFormat, accent: 'blue' } as ReportFormat
    await expect(
      renderReport(sampleDoc, badFormat, {
        typstPath: 'typst',
        timeoutMs: 5000,
        maxPages: 30,
        maxBytes: 5_242_880,
        tmpDir: scratch,
        run
      })
    ).rejects.toSatisfy((err: unknown) => err instanceof RenderError && err.kind === 'invalid')
  })

  it('handles missing binary errors as engine failures', async () => {
    const scratch = tmpDir()
    const run: RenderRunner = () => {
      const { proc } = makeFakeProcess()
      const err = Object.assign(new Error('not found'), { code: 'ENOENT' })
      queueMicrotask(() => proc.emit('error', err))
      return proc
    }

    await expect(
      renderReport(sampleDoc, defaultFormat, {
        typstPath: 'missing-typst',
        timeoutMs: 5000,
        maxPages: 30,
        maxBytes: 5_242_880,
        tmpDir: scratch,
        run
      })
    ).rejects.toSatisfy((err: unknown) => err instanceof RenderError && err.kind === 'engine')
    expect(readdirSync(scratch)).toEqual([])
  })
})

describe('isTypstAvailable', () => {
  it('returns true when binary exits 0 and false when it fails or is missing', async () => {
    const scratch = tmpDir()
    const okBin = fakeExecutable(scratch, 'typst-ok', 'process.exit(0)')
    const failBin = fakeExecutable(scratch, 'typst-fail', 'process.exit(1)')

    expect(await isTypstAvailable(okBin)).toBe(true)
    expect(await isTypstAvailable(failBin)).toBe(false)
    expect(await isTypstAvailable(join(scratch, 'does-not-exist'))).toBe(false)
    expect(await isTypstAvailable('')).toBe(false)
  })
})

describe('renderNote', () => {
  const sampleNote: NoteDocument = {
    title: 'Sprint Retrospective',
    sections: [
      { heading: 'What Went Well', body: 'Shipped the release on schedule.\n\n- Zero downtime\n- Clean rollback test' },
      { heading: 'Next Steps', body: 'Monitor disk alerts for seven days.' }
    ]
  }

  it('stages data.json and note.typ, runs typst with safe argv, and cleans up', async () => {
    const scratch = tmpDir()
    let seenArgs: readonly string[] = []
    let stagedFiles: string[] = []
    let stagedData: unknown = null
    let stagedTemplate = ''

    const run: RenderRunner = (_command, args, options) => {
      seenArgs = args
      stagedFiles = readdirSync(options.cwd).sort()
      stagedData = JSON.parse(readFileSync(join(options.cwd, 'data.json'), 'utf8'))
      stagedTemplate = readFileSync(join(options.cwd, 'note.typ'), 'utf8')

      const { proc, stdout, stderr } = makeFakeProcess()
      writeFileSync(join(options.cwd, 'out.pdf'), fakePdf(1))
      stdout.end()
      stderr.end()
      queueMicrotask(() => proc.emit('close', 0, null))
      return proc
    }

    const result = await renderNote(sampleNote, defaultFormat, {
      typstPath: 'typst',
      timeoutMs: 5000,
      maxPages: 30,
      maxBytes: 5_242_880,
      tmpDir: scratch,
      run
    })

    expect(seenArgs.slice(-2)).toEqual(['note.typ', 'out.pdf'])
    expect(stagedFiles).toEqual(['data.json', 'note.typ'])
    expect(stagedData).toEqual({ doc: sampleNote, format: defaultFormat })
    expect(stagedTemplate).toContain('json(sys.inputs.data)')
    expect(stagedTemplate).toContain('text(sec.heading)')
    expect(result.pages).toBe(1)
    expect(result.pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(readdirSync(scratch)).toEqual([])
  })

  it('rejects invalid note documents without running typst or leaking note text', async () => {
    const scratch = tmpDir()
    let ran = false
    const run: RenderRunner = () => {
      ran = true
      return makeFakeProcess().proc
    }

    let caught: unknown = null
    try {
      await renderNote(
        { title: 'ab', sections: [{ heading: 'H', body: 'CANARY_PRIVATE_NOTE_TEXT' }] } as NoteDocument,
        defaultFormat,
        { typstPath: 'typst', timeoutMs: 5000, maxPages: 30, maxBytes: 5_242_880, tmpDir: scratch, run }
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(RenderError)
    expect((caught as RenderError).kind).toBe('invalid')
    expect((caught as RenderError).message).not.toContain('CANARY_PRIVATE_NOTE_TEXT')
    expect(ran).toBe(false)
    expect(readdirSync(scratch)).toEqual([])
  })

  it('refuses note PDFs exceeding maxPages or maxBytes and cleans up', async () => {
    const scratch = tmpDir()
    const tooManyPagesRunner: RenderRunner = (_cmd, _args, options) => {
      const { proc, stdout, stderr } = makeFakeProcess()
      writeFileSync(join(options.cwd, 'out.pdf'), fakePdf(3))
      stdout.end()
      stderr.end()
      queueMicrotask(() => proc.emit('close', 0, null))
      return proc
    }

    await expect(
      renderNote(sampleNote, defaultFormat, {
        typstPath: 'typst',
        timeoutMs: 5000,
        maxPages: 2,
        maxBytes: 5_242_880,
        tmpDir: scratch,
        run: tooManyPagesRunner
      })
    ).rejects.toSatisfy((err: unknown) => err instanceof RenderError && err.kind === 'too_large')
    expect(readdirSync(scratch)).toEqual([])
  })
})
