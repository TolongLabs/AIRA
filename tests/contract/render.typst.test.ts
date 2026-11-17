import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isTypstAvailable, renderReport } from '../../src/render/render.js'
import { type ReportDocument, reportDocumentSchema, reportFormatSchema } from '../../src/render/types.js'
import { tmpDir } from '../support/tmp.js'

const sampleDoc = reportDocumentSchema.parse(JSON.parse(readFileSync('tests/fixtures/report/sample.json', 'utf8')))
const defaultFormat = reportFormatSchema.parse({})

function hasPdfToText(): boolean {
  const probe = spawnSync('pdftotext', ['-v'], { shell: false, stdio: 'ignore' })
  return probe.error === undefined && probe.status === 0
}

function extractPdfText(pdf: Buffer): string {
  const dir = tmpDir()
  const pdfPath = join(dir, 'out.pdf')
  writeFileSync(pdfPath, pdf)
  const res = spawnSync('pdftotext', [pdfPath, '-'], { shell: false, encoding: 'utf8' })
  expect(res.status).toBe(0)
  return res.stdout
}

describe.skipIf(!(await isTypstAvailable('typst')))('renderReport with real typst binary', () => {
  it('renders the sample fixture including Chinese findings', async () => {
    const result = await renderReport(sampleDoc, defaultFormat, {
      typstPath: 'typst',
      timeoutMs: 20_000,
      maxPages: 30,
      maxBytes: 5_242_880
    })

    expect(result.pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(result.pages).toBeGreaterThanOrEqual(2)

    if (hasPdfToText()) {
      const text = extractPdfText(result.pdf)
      expect(text).toContain('Urban Microgrid Battery Storage Economics')
      expect(text).toContain('分布式储能系统可将高峰电网负荷削减约百分之二十二')
      expect(text).toContain('example.com')
    }
  })

  it('prints Typst syntax tokens literally instead of evaluating them', async () => {
    const literalDoc: ReportDocument = {
      ...sampleDoc,
      title: 'Literal Syntax Check #1',
      question: 'Does $x$ and *bold* remain literal?',
      summary: 'Check #read("/etc/passwd") and $x$ and *bold* in summary.',
      keyFindings: [
        { text: 'Finding with #read("/etc/passwd") literal call', sources: [1] },
        { text: 'Finding with math token $x$ literal', sources: [2] },
        { text: 'Finding with markup token *bold* literal', sources: [3] }
      ],
      sections: [
        {
          heading: 'Section *bold* $x$',
          body: 'Paragraph holding #read("/etc/passwd") safely.\n\n- Bullet with $x$ and *bold*',
          sources: [1]
        },
        {
          heading: 'Second Section',
          body: 'Standard follow-up paragraph for schema bounds.',
          sources: [2]
        }
      ]
    }

    const result = await renderReport(literalDoc, defaultFormat, {
      typstPath: 'typst',
      timeoutMs: 20_000,
      maxPages: 30,
      maxBytes: 5_242_880
    })

    expect(result.pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(result.pages).toBeGreaterThanOrEqual(1)

    if (hasPdfToText()) {
      const text = extractPdfText(result.pdf)
      expect(text).toContain('#read("/etc/passwd")')
      expect(text).toContain('$x$')
      expect(text).toContain('*bold*')
      expect(text).not.toContain('root:x:0:0')
    }
  })

  it('renders without cover or appendix when disabled in format', async () => {
    const compactFormat = reportFormatSchema.parse({
      pageSize: 'Letter',
      accent: '#1f4e79',
      fontSize: 9.5,
      cover: false,
      sourcesAppendix: false,
      header: 'Internal Research Brief'
    })

    const result = await renderReport(sampleDoc, compactFormat, {
      typstPath: 'typst',
      timeoutMs: 20_000,
      maxPages: 30,
      maxBytes: 5_242_880
    })

    expect(result.pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(result.pages).toBeGreaterThanOrEqual(1)

    if (hasPdfToText()) {
      const text = extractPdfText(result.pdf)
      expect(text).toContain('Internal Research Brief')
      expect(text).not.toContain('https://example.com/reports/microgrid-storage-2026')
    }
  })
})
