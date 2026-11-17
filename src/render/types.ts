import { z } from 'zod'

export const reportSourceSchema = z.strictObject({
  n: z.number().int().min(1).max(12),
  title: z.string().trim().min(1).max(200),
  url: z.string().url().max(2000),
  domain: z.string().trim().min(1).max(253),
  accessedAt: z.iso.datetime()
})

export const reportDocumentSchema = z.strictObject({
  title: z.string().trim().min(4).max(120),
  question: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(700),
  keyFindings: z
    .array(
      z.strictObject({
        text: z.string().trim().min(1).max(300),
        sources: z.array(z.number().int().min(1)).min(1)
      })
    )
    .min(3)
    .max(7),
  sections: z
    .array(
      z.strictObject({
        heading: z.string().trim().min(1).max(80),
        body: z.string().trim().min(1).max(2500),
        sources: z.array(z.number().int().min(1))
      })
    )
    .min(2)
    .max(6),
  limitations: z.array(z.string().trim().min(1).max(300)).max(4),
  sources: z.array(reportSourceSchema).min(1).max(12)
})
export type ReportDocument = z.infer<typeof reportDocumentSchema>

export const noteDocumentSchema = z.strictObject({
  title: z.string().trim().min(4).max(120),
  sections: z
    .array(
      z.strictObject({
        heading: z.string().trim().min(1).max(80),
        body: z.string().trim().min(1).max(4000)
      })
    )
    .min(1)
    .max(8)
})
export type NoteDocument = z.infer<typeof noteDocumentSchema>

export const reportFormatSchema = z.strictObject({
  pageSize: z.enum(['A4', 'Letter']).default('A4'),
  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#2f6fde'),
  fontSize: z.number().min(9).max(12).default(10.5),
  cover: z.boolean().default(true),
  sourcesAppendix: z.boolean().default(true),
  header: z.string().trim().max(80).default('')
})
export type ReportFormat = z.infer<typeof reportFormatSchema>
