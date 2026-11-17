import type { ToolPorts } from '../ports.js'
import { registryDepsOf, type ToolRegistry } from '../registry.js'
import { helpTool, listTool } from './describe.js'
import { forgetTool, historySearchTool, lingoNoteTool, noteTool, recallTool } from './memory.js'
import { setMuteTool } from './mute.js'
import { reminderCancelTool, reminderListTool, reminderSetTool } from './reminders.js'
import { makeReportTool } from './report.js'
import { reportPdfTool, researchStartTool } from './research.js'
import { readPageTool, readPostTool, sendPhotoTool, webSearchTool } from './web.js'

export const CORE_TOOL_NAMES = [
  'recall',
  'note',
  'forget',
  'history_search',
  'lingo_note',
  'web_search',
  'read_page',
  'read_post',
  'send_photo',
  'reminder_set',
  'reminder_list',
  'reminder_cancel',
  'set_mute',
  'make_report',
  'research_start',
  'report_pdf',
  'help',
  'list'
] as const

export function registerCoreTools(registry: ToolRegistry, ports: ToolPorts): void {
  const { storage, logger } = registryDepsOf(registry)

  registry.register(recallTool(ports))
  registry.register(noteTool(ports))
  registry.register(forgetTool(ports))
  registry.register(historySearchTool(ports))
  registry.register(lingoNoteTool(ports))
  registry.register(webSearchTool(ports))
  registry.register(readPageTool(ports))
  registry.register(readPostTool(ports))
  registry.register(sendPhotoTool(storage, ports))
  registry.register(reminderSetTool(storage, ports, logger))
  registry.register(reminderListTool(storage))
  registry.register(reminderCancelTool(storage, ports, logger))
  registry.register(setMuteTool(storage))
  registry.register(makeReportTool(storage, ports))
  registry.register(researchStartTool(storage))
  registry.register(reportPdfTool(ports))
  registry.register(helpTool(registry))
  registry.register(listTool(registry))
}
