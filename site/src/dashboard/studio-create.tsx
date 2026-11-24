import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Copy, X } from 'lucide-react'
import { toast } from '@/lib/hooks'
import { motif } from './profile-image'
import { blankDraft, studioHref, studioPaths } from './studio-client'

const instructions =
  `Help me create an AIRA persona pack for import in Character Studio. Ask about identity, languages, speech rules, moods, and fallback lines before writing. Use an original fictional persona. Return one JSON file with card, moods and lines, matching the template below. Set card.id to a unique lowercase slug. Fill every required field. Give each mood a name, a tone, trigger phrases, opening and ending phrases, and a valid kaomoji face. Keep sticker lists empty unless assets are available. Provide the file for me to review and import.

` + JSON.stringify(blankDraft(), null, 2)

export function CreatePersona() {
  const [agent, setAgent] = useState(false)
  return (
    <Dialog.Root
      onOpenChange={(open) => {
        if (open) setAgent(false)
      }}
    >
      <Dialog.Trigger className="workspace-tool" data-primary>
        Create
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dashboard-modal-scrim" />
        <Dialog.Content className="dashboard-modal persona-create-dialog">
          <Dialog.Title>{agent ? 'Set Up With an Agent' : 'Create a Persona'}</Dialog.Title>
          <Dialog.Description>
            {agent
              ? 'Copy the prompt into your agent, then import its JSON file.'
              : 'Choose how to start this persona.'}
          </Dialog.Description>
          {agent ? (
            <>
              <textarea
                readOnly
                aria-label="Persona setup prompt"
                rows={7}
                value={instructions}
                onFocus={(e) => e.target.select()}
              />
              <div className="dashboard-modal-actions">
                <button onClick={() => setAgent(false)}>Back</button>
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(instructions)
                      toast('Prompt copied.')
                    } catch {
                      toast('Select the prompt and copy it manually.', false)
                    }
                  }}
                >
                  <Copy size={16} /> Copy Prompt
                </button>
              </div>
            </>
          ) : (
            <div className="create-choices">
              {(['Agent', 'Manual', 'Import'] as const).map((name, i) => {
                const body = (
                  <>
                    <img src={motif('', i)} alt="" />
                    <strong>{name}</strong>
                    <small>{['Copy a setup prompt', 'Start with a blank pack', 'Load a pack or JSON file'][i]}</small>
                  </>
                )
                return name === 'Agent' ? (
                  <button key={name} onClick={() => setAgent(true)}>
                    {body}
                  </button>
                ) : (
                  <a key={name} href={studioHref(name === 'Manual' ? studioPaths.create : studioPaths.import)}>
                    {body}
                  </a>
                )
              })}
            </div>
          )}
          <Dialog.Close className="create-close" aria-label="Close">
            <X size={18} />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
