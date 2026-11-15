import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PackError, loadPack, loadPacks } from '../../src/character/loader.js'
import { LINE_KINDS } from '../../src/character/schema.js'
import { stickerHostPath, writeUnavailableLine } from '../../src/character/unavailable.js'
import { tmpDir } from '../support/tmp.js'

function copyExamplePack(parentDir: string, id = 'example'): string {
  const dest = join(parentDir, id)
  cpSync('characters/example', dest, { recursive: true })
  if (id !== 'example') {
    const cardPath = join(dest, 'card.yml')
    const card = readFileSync(cardPath, 'utf8').replace(/^id: example$/m, `id: ${id}`)
    writeFileSync(cardPath, card)
  }
  return dest
}

function expectPackError(fn: () => unknown): PackError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(PackError)
    return error as PackError
  }
  throw new Error('expected PackError to be thrown')
}

describe('character pack loader', () => {
  it('loads the repository example pack with every line kind, default mood and compiled patterns', () => {
    const pack = loadPack('characters/example', 'repository')
    expect(pack.id).toBe('example')
    expect(pack.source).toBe('repository')
    expect(pack.moods.has(pack.defaultMood)).toBe(true)
    for (const kind of LINE_KINDS) {
      expect(pack.lines[kind].length).toBeGreaterThan(0)
    }
    const neutral = pack.moods.get('neutral')
    expect(neutral).toBeDefined()
    expect(neutral?.patterns.length).toBeGreaterThan(0)
    for (const pattern of neutral?.patterns ?? []) {
      expect(pattern).toBeInstanceOf(RegExp)
      expect(pattern.flags).toContain('i')
      expect(pattern.flags).toContain('u')
    }
  })

  it('catches and names a missing required file', () => {
    for (const file of ['card.yml', 'moods.yml', 'lines.yml'] as const) {
      const dir = copyExamplePack(tmpDir())
      rmSync(join(dir, file))
      const error = expectPackError(() => loadPack(dir, 'repository'))
      expect(error.message).toMatch(/^character pack example is invalid:/)
      expect(error.message).toContain(file)
    }
  })

  it('catches and names YAML that does not parse', () => {
    const dir = copyExamplePack(tmpDir())
    writeFileSync(join(dir, 'card.yml'), 'id: [unclosed\n')
    const error = expectPackError(() => loadPack(dir, 'repository'))
    expect(error.message).toContain('card.yml')
    expect(error.message).toContain('invalid YAML')
  })

  it('does not quote the pack file when its YAML does not parse', () => {
    const dir = copyExamplePack(tmpDir())
    writeFileSync(join(dir, 'lines.yml'), "error: 'a private line that must stay private\nlimit: [unclosed\n")
    const error = expectPackError(() => loadPack(dir, 'repository'))
    expect(error.message).toContain('lines.yml: invalid YAML')
    expect(error.message).not.toContain('private line')
  })

  it('catches and names an unknown key in each file', () => {
    const cases: Array<{ file: 'card.yml' | 'moods.yml' | 'lines.yml'; extra: string }> = [
      { file: 'card.yml', extra: 'extraField: unexpected\n' },
      { file: 'moods.yml', extra: 'extraField: unexpected\n' },
      { file: 'lines.yml', extra: 'extraField: unexpected\n' }
    ]
    for (const { file, extra } of cases) {
      const dir = copyExamplePack(tmpDir())
      const path = join(dir, file)
      writeFileSync(path, `${readFileSync(path, 'utf8')}\n${extra}`)
      const error = expectPackError(() => loadPack(dir, 'repository'))
      expect(error.message).toContain(file)
      expect(error.message).toContain('extraField')
    }
  })

  it('rejects card.id that differs from the folder name', () => {
    const dir = copyExamplePack(tmpDir(), 'alpha')
    const cardPath = join(dir, 'card.yml')
    writeFileSync(cardPath, readFileSync(cardPath, 'utf8').replace('id: alpha', 'id: beta'))
    const error = expectPackError(() => loadPack(dir, 'repository'))
    expect(error.message).toContain('card.yml: id:')
  })

  it('rejects default naming a mood that does not exist', () => {
    const dir = copyExamplePack(tmpDir())
    const moodsPath = join(dir, 'moods.yml')
    writeFileSync(moodsPath, readFileSync(moodsPath, 'utf8').replace('default: neutral', 'default: missing_mood'))
    const error = expectPackError(() => loadPack(dir, 'repository'))
    expect(error.message).toContain('moods.yml: default:')
  })

  it('rejects a pattern that does not compile and names the mood and index', () => {
    const dir = copyExamplePack(tmpDir())
    const moodsPath = join(dir, 'moods.yml')
    writeFileSync(moodsPath, readFileSync(moodsPath, 'utf8').replace("      - '\\?$'", "      - '[unclosed'"))
    const error = expectPackError(() => loadPack(dir, 'repository'))
    expect(error.message).toContain('moods.yml: moods.neutral.patterns.1:')
  })

  it('rejects a missing line kind', () => {
    const dir = copyExamplePack(tmpDir())
    const linesPath = join(dir, 'lines.yml')
    const withoutUnavailable = readFileSync(linesPath, 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('unavailable:'))
      .join('\n')
    writeFileSync(linesPath, withoutUnavailable)
    const error = expectPackError(() => loadPack(dir, 'repository'))
    expect(error.message).toContain('lines.yml: unavailable:')
  })

  it('rejects an empty line and a line with a line break', () => {
    const dirEmpty = copyExamplePack(tmpDir())
    const linesEmpty = join(dirEmpty, 'lines.yml')
    writeFileSync(linesEmpty, readFileSync(linesEmpty, 'utf8').replace(/^error: .+$/m, "error: ''"))
    const errEmpty = expectPackError(() => loadPack(dirEmpty, 'repository'))
    expect(errEmpty.message).toContain('lines.yml: error:')

    const dirBreak = copyExamplePack(tmpDir())
    const linesBreak = join(dirBreak, 'lines.yml')
    writeFileSync(linesBreak, readFileSync(linesBreak, 'utf8').replace(/^error: .+$/m, 'error: "first\\nsecond"'))
    const errBreak = expectPackError(() => loadPack(dirBreak, 'repository'))
    expect(errBreak.message).toContain('lines.yml: error:')
  })

  it('rejects a sticker that is named but missing', () => {
    const dir = copyExamplePack(tmpDir())
    const moodsPath = join(dir, 'moods.yml')
    writeFileSync(
      moodsPath,
      readFileSync(moodsPath, 'utf8').replace('    stickers: []', '    stickers:\n      - wave.webp')
    )
    const error = expectPackError(() => loadPack(dir, 'repository'))
    expect(error.message).toContain('moods.yml: moods.neutral.stickers:')
  })

  it('rejects an empty moods record', () => {
    const dir = copyExamplePack(tmpDir())
    writeFileSync(join(dir, 'moods.yml'), 'default: neutral\nmoods: {}\n')
    const error = expectPackError(() => loadPack(dir, 'repository'))
    expect(error.message).toContain('moods.yml: moods:')
  })

  it('collects multiple faults in one error message', () => {
    const dir = copyExamplePack(tmpDir(), 'alpha')
    const cardPath = join(dir, 'card.yml')
    writeFileSync(cardPath, readFileSync(cardPath, 'utf8').replace('id: alpha', 'id: wrong'))
    const moodsPath = join(dir, 'moods.yml')
    writeFileSync(moodsPath, readFileSync(moodsPath, 'utf8').replace('default: neutral', 'default: absent'))
    const error = expectPackError(() => loadPack(dir, 'repository'))
    expect(error.message).toContain('card.yml: id:')
    expect(error.message).toContain('moods.yml: default:')
  })

  it('never includes persona text in a PackError message', () => {
    const dir = copyExamplePack(tmpDir())
    const secretCore = 'SECRET_CORE_IDENTITY_TOKEN'
    const secretSpeech = 'SECRET_SPEECH_RULE_TOKEN'
    const secretTone = 'SECRET_TONE_TOKEN'
    const secretOpener = 'SECRET_OPENER_TOKEN'
    const secretEnding = 'SECRET_ENDING_TOKEN'
    const secretLine = 'SECRET_UNAVAILABLE_LINE_TOKEN'

    writeFileSync(
      join(dir, 'card.yml'),
      [
        'id: example',
        'displayName: Example',
        'languages: [en]',
        `coreIdentity: "${secretCore}"`,
        'speechRules:',
        `  - "${secretSpeech}"`,
        'defaultReplyLength: short',
        'unknownKey: 1'
      ].join('\n')
    )
    writeFileSync(
      join(dir, 'moods.yml'),
      [
        'default: missing_mood',
        'moods:',
        '  neutral:',
        '    patterns: []',
        `    tone: "${secretTone}"`,
        `    openers: ["${secretOpener}"]`,
        `    endings: ["${secretEnding}"]`,
        '    faces: []',
        '    stickers: []'
      ].join('\n')
    )
    const linesPath = join(dir, 'lines.yml')
    writeFileSync(
      linesPath,
      readFileSync(linesPath, 'utf8').replace(/^unavailable: .+$/m, `unavailable: "${secretLine}"\nextra: 1`)
    )

    const error = expectPackError(() => loadPack(dir, 'repository'))
    for (const secret of [secretCore, secretSpeech, secretTone, secretOpener, secretEnding, secretLine]) {
      expect(error.message).not.toContain(secret)
    }
  })

  it('accepts a sticker that exists in stickers/', () => {
    const dir = copyExamplePack(tmpDir())
    mkdirSync(join(dir, 'stickers'))
    writeFileSync(join(dir, 'stickers', 'wave.webp'), 'RIFFfakewebp')
    const moodsPath = join(dir, 'moods.yml')
    writeFileSync(
      moodsPath,
      readFileSync(moodsPath, 'utf8').replace('    stickers: []', '    stickers:\n      - wave.webp')
    )
    const pack = loadPack(dir, 'data')
    expect(pack.moods.get('neutral')?.stickers).toEqual(['wave.webp'])
  })
})

describe('loadPacks', () => {
  it('loads packs from both roots and lets the data volume win for the same id', () => {
    const repoDir = tmpDir()
    const dataDir = tmpDir()
    copyExamplePack(repoDir, 'shared')
    copyExamplePack(repoDir, 'repo_only')
    const dataShared = copyExamplePack(dataDir, 'shared')
    const cardPath = join(dataShared, 'card.yml')
    writeFileSync(cardPath, readFileSync(cardPath, 'utf8').replace('displayName: Example', 'displayName: DataShared'))
    copyExamplePack(dataDir, 'data_only')

    const result = loadPacks({ repositoryDir: repoDir, dataDir })
    expect(result.faults).toEqual([])
    expect([...result.packs.keys()].sort()).toEqual(['data_only', 'repo_only', 'shared'])
    expect(result.packs.get('shared')?.source).toBe('data')
    expect(result.packs.get('shared')?.card.displayName).toBe('DataShared')
    expect(result.packs.get('repo_only')?.source).toBe('repository')
  })

  it('records a fault for an invalid data pack and does not fall back to the repository pack with the same id', () => {
    const repoDir = tmpDir()
    const dataDir = tmpDir()
    copyExamplePack(repoDir, 'shared')
    const badData = copyExamplePack(dataDir, 'shared')
    rmSync(join(badData, 'lines.yml'))

    const result = loadPacks({ repositoryDir: repoDir, dataDir })
    expect(result.packs.has('shared')).toBe(false)
    expect(result.faults.map((f) => f.id)).toEqual(['shared'])
  })

  it('loads valid packs even when another pack is invalid, ignores plain files and skips missing roots', () => {
    const repoDir = tmpDir()
    copyExamplePack(repoDir, 'good')
    const bad = copyExamplePack(repoDir, 'bad')
    rmSync(join(bad, 'card.yml'))
    writeFileSync(join(repoDir, 'README.txt'), 'not a pack')

    const result = loadPacks({
      repositoryDir: repoDir,
      dataDir: join(tmpDir(), 'does-not-exist')
    })
    expect([...result.packs.keys()]).toEqual(['good'])
    expect(result.faults.map((f) => f.id)).toEqual(['bad'])
  })
})

describe('unavailable line and sticker host path', () => {
  it('writes the unavailable line with a final newline and replaces an older file', () => {
    const dataDir = tmpDir()
    const pack = loadPack('characters/example', 'repository')
    const target = writeUnavailableLine(dataDir, pack)
    expect(target).toBe(join(dataDir, 'gateway', 'unavailable.txt'))
    expect(readFileSync(target, 'utf8')).toBe(`${pack.lines.unavailable}\n`)

    const updated: typeof pack = {
      ...pack,
      lines: { ...pack.lines, unavailable: 'Back shortly.' }
    }
    writeUnavailableLine(dataDir, updated)
    expect(readFileSync(target, 'utf8')).toBe('Back shortly.\n')
  })

  it('builds the sticker host path and refuses path traversal', () => {
    expect(stickerHostPath('/srv/aira-data', 'example', 'wave.webp')).toBe(
      '/srv/aira-data/characters/example/stickers/wave.webp'
    )
    expect(() => stickerHostPath('/srv/aira-data', '../evil', 'wave.webp')).toThrow(PackError)
    expect(() => stickerHostPath('/srv/aira-data', 'example', '../secret.webp')).toThrow(PackError)
  })
})
