// Checks that every diagram source has a rendered SVG and a Markdown embed.
//
// Read-only by default: it only reads tracked files and prints a manifest.
// Pass --render to re-render every source with the Archify 3.2.0 CLI command
// from docs/diagrams/README.md, export the SVGs with
// scripts/export-diagrams.mjs, then check.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_PREFIX = 'docs/diagrams/src/'
const SVG_PATTERN = /^docs\/diagrams\/[^/]+\.svg$/
const STEM = /^[a-z0-9-]+$/
const EMBED = /!\[[^\]]*\]\(([^\s)]+\.svg)\)/g
const RENDER_DIR = join(ROOT, '.archify')
const EXPORT_SCRIPT = join(ROOT, 'scripts/export-diagrams.mjs')

const USAGE = [
  'usage: node scripts/check-diagrams.mjs [--render [--archify-root <path>]]',
  '',
  'Checks diagram sources against their SVGs and Markdown embeds.',
  'With --render, re-renders every source with the Archify 3.2.0 CLI,',
  'exports the SVGs, then checks. <path> replaces <archify> in the',
  'README command; ARCHIFY_DIR is used when the flag is absent.'
].join('\n')

function tracked() {
  const raw = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  return raw.split('\0').filter((name) => name !== '')
}

function stemOf(path, prefix, suffix) {
  return basename(path.slice(prefix.length), suffix)
}

function findEmbeds(mdFiles) {
  const byStem = new Map()
  let refs = 0
  for (const file of mdFiles) {
    const content = readFileSync(join(ROOT, file), 'utf8')
    for (const match of content.matchAll(EMBED)) {
      const target = resolve(ROOT, dirname(file), match[1])
      if (dirname(target) !== resolve(ROOT, 'docs/diagrams')) continue
      refs++
      const stem = basename(target, '.svg')
      if (!byStem.has(stem)) byStem.set(stem, [])
      const line = content.slice(0, match.index).split('\n').length
      byStem.get(stem).push(file + ':' + line)
    }
  }
  return { byStem, refs }
}

function countCodeRefs(node) {
  if (Array.isArray(node)) return node.reduce((sum, item) => sum + countCodeRefs(item), 0)
  if (node !== null && typeof node === 'object') {
    let sum = 0
    for (const [key, value] of Object.entries(node)) {
      if (key === 'sources' && Array.isArray(value)) {
        sum += value.filter((item) => item !== null && typeof item === 'object' && typeof item.path === 'string').length
      } else {
        sum += countCodeRefs(value)
      }
    }
    return sum
  }
  return 0
}

function readSource(stem) {
  try {
    const json = JSON.parse(readFileSync(join(ROOT, `${SRC_PREFIX}${stem}.json`), 'utf8'))
    const meta = json.meta ?? {}
    const declared = meta.quality_profile ?? json.quality_profile
    const type = typeof json.diagram_type === 'string' ? json.diagram_type : 'unknown'
    const repository = meta.repository && typeof meta.repository === 'object' ? 'yes' : null
    return {
      type,
      profile: declared ?? 'showcase',
      defaulted: declared === undefined,
      repository,
      codeRefs: countCodeRefs(json)
    }
  } catch (error) {
    return { error: error.message }
  }
}

function render(sources, archifyRoot) {
  const root = resolve(archifyRoot ?? '')
  const cli = join(root, 'bin/archify.mjs')
  if (archifyRoot === undefined || !existsSync(cli)) {
    throw new Error(`archify CLI not found at ${cli} (pass --archify-root <archify> or set ARCHIFY_DIR)`)
  }
  mkdirSync(RENDER_DIR, { recursive: true })
  for (const source of sources) {
    if (source.type === 'unknown') throw new Error(`${source.stem}: no diagram_type, cannot render`)
    const args = [
      'finalize',
      source.type,
      `${SRC_PREFIX}${source.stem}.json`,
      `.archify/${source.stem}.html`,
      '--quality',
      source.profile
    ]
    // README renders sources that cite code with --repo-root .; a source
    // cites code through meta.repository or through sources[].path entries.
    if (source.repository !== null || source.codeRefs > 0) args.push('--repo-root', '.')
    console.log(`+ node ${[cli, ...args].join(' ')}`)
    const run = spawnSync('node', [cli, ...args], { cwd: ROOT, stdio: 'inherit' })
    if (run.status !== 0) throw new Error(`render failed for ${source.stem}`)
  }
  // Exporting stays in scripts/export-diagrams.mjs; this script never rewrites it.
  console.log('+ node scripts/export-diagrams.mjs')
  const exported = spawnSync('node', [EXPORT_SCRIPT], { cwd: ROOT, stdio: 'inherit' })
  if (exported.status !== 0) throw new Error('scripts/export-diagrams.mjs failed')
}

function table(headers, rows) {
  const widths = headers.map((head, i) => Math.max(head.length, ...rows.map((row) => row[i].length)))
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ')
  return [line(headers), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join('\n')
}

function check() {
  const files = tracked()
  const sourceStems = files
    .filter(
      (file) => file.startsWith(SRC_PREFIX) && file.endsWith('.json') && STEM.test(stemOf(file, SRC_PREFIX, '.json'))
    )
    .map((file) => stemOf(file, SRC_PREFIX, '.json'))
    .sort()
  const svgStems = [
    ...new Set(files.filter((file) => SVG_PATTERN.test(file)).map((file) => basename(file, '.svg')))
  ].sort()
  const mdFiles = files.filter((file) => file.endsWith('.md')).sort()
  const { byStem, refs } = findEmbeds(mdFiles)
  const sources = sourceStems.map((stem) => ({ stem, ...readSource(stem) }))
  const sourceSet = new Set(sourceStems)
  const svgSet = new Set(svgStems)

  const rows = sources.map((source) => {
    if (source.error !== undefined) return [source.stem, `error: ${source.error}`, '-', '-', '-', '-', '-']
    const locations = byStem.get(source.stem) ?? []
    const embeddedIn = [...new Set(locations.map((location) => location.split(':')[0]))].sort()
    return [
      source.stem,
      source.type,
      source.defaulted ? `${source.profile} (default)` : source.profile,
      source.repository ?? '-',
      svgSet.has(source.stem) ? 'yes' : 'no',
      String(locations.length),
      embeddedIn.join(',') || '-'
    ]
  })

  const missingSvg = sourceStems.filter((stem) => !svgSet.has(stem))
  const orphanSvg = svgStems.filter((stem) => !sourceSet.has(stem))
  const unembedded = sources.filter(
    (source) => source.error === undefined && svgSet.has(source.stem) && !byStem.has(source.stem)
  )
  const unreadable = sources.filter((source) => source.error !== undefined)
  const broken = []
  for (const [stem, locations] of [...byStem.entries()].sort()) {
    if (!svgSet.has(stem))
      for (const location of locations) broken.push(`${location} -> ${stem}.svg (no committed svg)`)
  }
  const types = [...new Set(sources.filter((source) => source.error === undefined).map((source) => source.type))].sort()
  const repoBacked = sources
    .filter((source) => source.repository !== null)
    .map((source) => source.stem)
    .sort()
  const problems = missingSvg.length + orphanSvg.length + unembedded.length + unreadable.length + broken.length

  const out = []
  out.push(table(['diagram', 'type', 'profile', 'repo', 'svg', 'embeds', 'embedded-in'], rows))
  out.push('')
  out.push(
    `sources=${sourceStems.length} svg=${svgStems.length} embed-refs=${refs} types=${types.length} repo-backed=${repoBacked.length}`
  )
  out.push(`types: ${types.join(', ') || '-'}`)
  out.push(`repo-backed: ${repoBacked.join(', ') || '-'}`)
  if (missingSvg.length > 0) out.push(`missing svg (${missingSvg.length}): ${missingSvg.join(', ')}`)
  if (orphanSvg.length > 0) out.push(`orphan svg (${orphanSvg.length}): ${orphanSvg.join(', ')}`)
  if (unembedded.length > 0)
    out.push(`unembedded (${unembedded.length}): ${unembedded.map((source) => source.stem).join(', ')}`)
  if (unreadable.length > 0)
    out.push(
      `unreadable (${unreadable.length}): ${unreadable.map((source) => `${source.stem}: ${source.error}`).join('; ')}`
    )
  if (broken.length > 0) out.push(`broken embeds (${broken.length}): ${broken.join('; ')}`)
  out.push(problems === 0 ? 'clean: every source has an svg and at least one embed' : `problems: ${problems}`)
  console.log(out.join('\n'))
  return problems === 0 ? 0 : 1
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE)
    return 0
  }
  let renderMode = false
  let archifyRoot = process.env.ARCHIFY_DIR
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--render') {
      renderMode = true
    } else if (args[i] === '--archify-root') {
      archifyRoot = args[i + 1]
      i += 1
    } else {
      throw new Error(`unknown argument: ${args[i]}\n${USAGE}`)
    }
  }
  if (archifyRoot === undefined && renderMode)
    throw new Error(`no archify root: pass --archify-root <archify> or set ARCHIFY_DIR\n${USAGE}`)
  if (renderMode) {
    const files = tracked()
    const stems = files
      .filter(
        (file) => file.startsWith(SRC_PREFIX) && file.endsWith('.json') && STEM.test(stemOf(file, SRC_PREFIX, '.json'))
      )
      .map((file) => stemOf(file, SRC_PREFIX, '.json'))
      .sort()
    render(
      stems.map((stem) => ({ stem, ...readSource(stem) })),
      archifyRoot
    )
  }
  return check()
}

try {
  process.exit(main())
} catch (error) {
  console.error(`check-diagrams: ${error.message}`)
  process.exit(2)
}
