import type { ToolPorts } from '../ports.js'
import { registryDepsOf, type ToolRegistry } from '../registry.js'
import { libraryGapsTool, libraryOpenTool, librarySearchTool, libraryWriteTool } from './library.js'
import { lyricsFetchTool, lyricsSearchTool, songGetTool, songSaveTool } from './songs.js'
import { glossSetTool, vocabLookupTool } from './words.js'

export const LESSON_TOOL_NAMES = [
  'lyrics_search',
  'lyrics_fetch',
  'song_get',
  'song_save',
  'vocab_lookup',
  'gloss_set',
  'library_search',
  'library_write',
  'library_open',
  'library_gaps'
] as const

export function registerLessonTools(registry: ToolRegistry, ports: ToolPorts): void {
  const { storage } = registryDepsOf(registry)

  registry.register(lyricsSearchTool(storage, ports))
  registry.register(lyricsFetchTool(storage, ports))
  registry.register(songGetTool(storage))
  registry.register(songSaveTool(storage))
  registry.register(vocabLookupTool(storage))
  registry.register(glossSetTool())
  registry.register(librarySearchTool(storage))
  registry.register(libraryWriteTool())
  registry.register(libraryOpenTool(storage))
  registry.register(libraryGapsTool(storage))
}
