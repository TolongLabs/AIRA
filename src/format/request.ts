// Detects an explicit request for a form or for detail in a user's message (docs/trd/prompt-engine.md).
// Such a request wins over the default reply shape and the default length (PRD FR-17).

const REQUESTS: [reason: string, pattern: RegExp][] = [
  ['table', /\b(?:as|in|into) (?:a |one )?table\b|\btabulate\b/i],
  ['steps', /\bstep[- ]by[- ]step\b|\b(?:numbered|ordered) (?:list|steps)\b|\bwalk me through\b/i],
  [
    'list',
    /\b(?:as|in|into) (?:a |one )?(?:bulleted |bullet |short )?list\b|\b(?:in|as|with) bullet(?:s| points)?\b|\blist (?:them|all|out|every)\b/i
  ],
  [
    'code',
    /\b(?:show|give|write|send)(?: me)? (?:the |some |a )?(?:full |whole |complete )?(?:code|script|snippet)\b|\bcode block\b/i
  ],
  [
    'detail',
    /\bin (?:more |full |great )?detail\b|\b(?:explain|describe|tell me)(?: it| this| that)? (?:fully|thoroughly|in depth|in full)\b|\bfull (?:explanation|answer|version)\b|\b(?:elaborate|go deeper)\b|\bdon'?t (?:shorten|summari[sz]e)\b/i
  ]
]

/** A short reason when the user asked for a form or for detail, else undefined. */
export function detectFormatRequest(userText: string): string | undefined {
  for (const [reason, pattern] of REQUESTS) if (pattern.test(userText)) return reason
  return undefined
}
