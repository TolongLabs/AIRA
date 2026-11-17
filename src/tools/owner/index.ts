// The owner's market and coding-session tools (docs/trd/tools.md#owner-tools), behind `features.owner`.
import type { Config } from '../../config/schema.js'
import type { ToolRegistry } from '../registry.js'
import { claudeTools } from './claude.js'
import { marketTools } from './market-tools.js'
import { createMarketsPort, type MarketsPort } from './markets.js'

export function registerOwnerTools(
  registry: ToolRegistry,
  config: Config['owner'],
  options: { markets?: MarketsPort; now?: () => Date } = {}
): void {
  const markets = options.markets ?? createMarketsPort({ timeoutMs: config.timeoutMs })
  const tools = [
    ...marketTools({ markets, ...(config.marketsConfig ? { configPath: config.marketsConfig } : {}) }),
    ...claudeTools({
      ...(config.claudeProjectsDir ? { projectsDir: config.claudeProjectsDir } : {}),
      ...(config.noticeRoutesFile ? { routesFile: config.noticeRoutesFile } : {}),
      ...(options.now ? { now: options.now } : {})
    })
  ]
  for (const tool of tools) registry.register(tool)
}
