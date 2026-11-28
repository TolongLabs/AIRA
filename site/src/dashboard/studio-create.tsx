import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowLeft, ArrowUpRight, Check, ClipboardCopy, FileJson, X } from 'lucide-react'
import { toast } from '@/lib/hooks'
import { motif } from './profile-image'
import { getPackSchema, studioHref, studioPaths } from './studio-client'

const agents = [
  { name: 'Claude', mark: 'claude', url: 'https://claude.ai/new' },
  { name: 'ChatGPT', mark: 'chatgpt', url: 'https://chatgpt.com/' },
  { name: 'Gemini', mark: 'gemini', url: 'https://gemini.google.com/app' }
]

function AgentPrompt({ back }: { back: () => void }) {
  const [copied, setCopied] = useState(false)
  const prompt = useRef<HTMLTextAreaElement>(null)
  const [instructions, setInstructions] = useState<string>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    void getPackSchema().then(
      (value) => {
        if (!cancelled) setInstructions(value.setupPrompt)
      },
      () => {
        if (!cancelled) setFailed(true)
      }
    )
    return () => {
      cancelled = true
    }
  }, [])
  async function copy() {
    if (!instructions) return
    try {
      await navigator.clipboard.writeText(instructions)
      setCopied(true)
      toast('Prompt copied.')
    } catch {
      prompt.current?.focus()
      prompt.current?.select()
      toast('Copy the selected prompt using your device’s copy command.', false)
    }
  }
  return (
    <>
      <section className="agent-prompt-panel" aria-labelledby="setup-prompt-title">
        <div className="agent-prompt-header">
          <h3 id="setup-prompt-title">
            <FileJson size={18} aria-hidden="true" />
            Persona setup prompt
          </h3>
          <button className="agent-copy" type="button" disabled={!instructions} onClick={() => void copy()}>
            {copied ? <Check size={16} /> : <ClipboardCopy size={16} />} {copied ? 'Copied' : 'Copy Prompt'}
          </button>
        </div>
        <textarea
          ref={prompt}
          readOnly
          aria-label="Persona setup prompt"
          rows={6}
          value={
            instructions ??
            (failed ? 'Setup prompt unavailable. Go back and try again.' : 'Loading the current pack schema…')
          }
          onFocus={(e) => e.target.select()}
        />
      </section>
      <section className="agent-destinations" aria-label="Open an agent">
        <h3>Open an agent</h3>
        <div>
          {agents.map((a) => (
            <a
              key={a.name}
              href={a.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={'Open ' + a.name + ' in a new tab'}
            >
              <img src={'/app/dashboard/agents/' + a.mark + '.svg'} alt="" width={22} height={22} />
              <span>{a.name}</span>
              <ArrowUpRight size={14} aria-hidden="true" />
            </a>
          ))}
        </div>
      </section>
      <div className="agent-footer">
        <button type="button" onClick={back}>
          <ArrowLeft size={14} /> Back
        </button>
        <a href={studioHref(studioPaths.import)}>
          Import JSON <ArrowUpRight size={14} />
        </a>
      </div>
    </>
  )
}

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
        <Dialog.Content className="dashboard-modal persona-create-dialog" data-agent={agent}>
          <Dialog.Title>{agent ? 'Set Up With an Agent' : 'Create a Persona'}</Dialog.Title>
          <Dialog.Description>
            {agent
              ? 'Copy the prompt into your preferred agent. When your persona is ready, import the JSON file here.'
              : 'Choose how to start this persona.'}
          </Dialog.Description>
          {agent ? (
            <AgentPrompt back={() => setAgent(false)} />
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
