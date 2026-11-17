import { z } from 'zod'
import { setSetting } from '../../settings/settings.js'
import { isoNow, type Storage } from '../../storage/database.js'
import type { ToolDefinition } from '../types.js'

const setMuteSchema = z.strictObject({
  muted: z.boolean()
})

export function setMuteTool(storage: Storage): ToolDefinition<z.infer<typeof setMuteSchema>> {
  return {
    name: 'set_mute',
    description: 'Stops or resumes proactive messages in this chat.',
    schema: setMuteSchema,
    mode: 'both',
    mutates: true,
    command: {
      names: ['mute', 'unmute'],
      kind: 'direct',
      usage: '/mute or /unmute',
      directArgs: (name) => ({ muted: name === 'mute' })
    },
    handler(args, context) {
      const value = args.muted ? { by: context.senderId, at: isoNow(context.now) } : false
      const { data } = context.commit(() => {
        setSetting(
          storage,
          {
            level: 'chat',
            scope: context.chat.chatId,
            key: 'muted',
            value,
            actor: context.senderId
          },
          context.now
        )
        return {
          data: { muted: args.muted },
          receipt: {
            kind: args.muted ? 'mute.on' : 'mute.off',
            target: context.chat.chatId,
            state: { muted: args.muted }
          }
        }
      })
      return { ok: true, data }
    }
  }
}
