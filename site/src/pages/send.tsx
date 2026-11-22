import { useEffect, useRef, useState } from 'react'
import { FileUp, Send as SendIcon, X } from 'lucide-react'
import type { SendRecord, SendView } from '@/lib/api'
import { get, postForm } from '@/lib/api'
import { toast, Toaster, useApi } from '@/lib/hooks'
import { ago, cn } from '@/lib/utils'
import { Shell } from '@/components/shell'
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Picker,
  Section,
  Segmented,
  Spinner,
  Textarea,
  Toggle
} from '@/components/ui'

/* The owner sends a file himself: one chat, one file, an optional message.
   It used to be an engineer running `hermes send` by hand. The server holds
   every fence (known chats only, Desktop and taildrop only, 100 MB); this
   page only makes the choice easy to see and asks once before it goes. */

/* The gateway's own sets: these two kinds are recompressed by WhatsApp
   unless they go as a document. Everything else always goes as one. */
const IMAGE = /\.(jpe?g|png|webp|gif)$/i
const VIDEO = /\.(mp4|mov|avi|mkv|webm|3gp)$/i

function mediaKind(name: string): 'photo' | 'video' | 'file' {
  if (IMAGE.test(name)) return 'photo'
  if (VIDEO.test(name)) return 'video'
  return 'file'
}

function fileSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  const mb = n / (1024 * 1024)
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

function when(ts: number): string {
  return new Date(ts * 1000).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  })
}

const SOURCES = ['upload', 'box'] as const
type Source = (typeof SOURCES)[number]

type Picked = { name: string; size: number; file?: File; path?: string }
type Stage = 'edit' | 'confirm' | 'sending'

export default function SendPage() {
  const view = useApi<SendView>('/api/send')
  const [recent, setRecent] = useState<SendRecord[] | null>(null)
  const [target, setTarget] = useState('')
  const [source, setSource] = useState<Source>('upload')
  const [upload, setUpload] = useState<File | null>(null)
  const [boxPath, setBoxPath] = useState('')
  const [message, setMessage] = useState('')
  const [full, setFull] = useState(true)
  const [stage, setStage] = useState<Stage>('edit')
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState<{ ok: boolean; text: string; uncertain?: boolean } | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (view.error) toast(view.error, false)
  }, [view.error])

  const data = view.data
  const max = data?.max_bytes ?? 100 * 1024 * 1024
  const maxMessage = data?.max_message ?? 4000
  const recipients = data?.recipients ?? []
  const files = data?.files ?? []
  const sendable = files.filter((f) => f.size > 0 && f.size <= max)
  const who = recipients.find((r) => r.target === target)
  const boxFile = files.find((f) => f.path === boxPath)

  const picked: Picked | null =
    source === 'upload'
      ? upload && { name: upload.name, size: upload.size, file: upload }
      : boxFile
        ? { name: boxFile.name, size: boxFile.size, path: boxFile.path }
        : null
  const kind = picked ? mediaKind(picked.name) : 'file'
  const asDocument = kind === 'file' || full

  /* A new file starts at full quality. Carrying "off" over from the last
     photo would quietly compress the next one. */
  useEffect(() => setFull(true), [picked?.name, picked?.size])

  /* The safe option takes focus, so Enter cancels — the same rule the
     app's destructive confirm follows. */
  useEffect(() => {
    if (stage === 'confirm') cancelRef.current?.focus()
  }, [stage])

  const problem = !picked
    ? ''
    : picked.size === 0
      ? 'That file is empty, so there is nothing to send.'
      : picked.size > max
        ? `That file is over ${fileSize(max)}, the most one send can carry.`
        : ''
  const ready = !!who && !!picked && !problem && message.length <= maxMessage

  function choose(list: FileList | null) {
    const f = list?.[0]
    if (!f) return
    setUpload(f)
    setResult(null)
  }

  async function send() {
    if (!who || !picked) return
    const form = new FormData()
    form.append('target', who.target)
    form.append('message', message.trim())
    form.append('document', asDocument ? '1' : '0')
    if (picked.file) form.append('file', picked.file, picked.file.name)
    else form.append('box', picked.path ?? '')
    setStage('sending')
    setProgress(0)
    try {
      const r = await postForm<{ recent: SendRecord[] }>('/api/send', form, setProgress)
      if (!Array.isArray(r.recent)) throw Object.assign(new Error('Missing send acknowledgement'), { uncertain: true })
      setRecent(r.recent)
      setResult({ ok: true, text: `${picked.name} went to ${who.name}.` })
      toast('sent')
      // The chat stays chosen: a second file to the same place is the
      // likeliest next thing. The file and the words were for this one.
      setUpload(null)
      setBoxPath('')
      setMessage('')
      if (fileInput.current) fileInput.current.value = ''
    } catch (e) {
      const err = e as Error & { uncertain?: boolean; body?: { recent?: SendRecord[] } }
      if (err.body?.recent) setRecent(err.body.recent)
      /* A dropped connection after upload may still have landed server-side.
         Refresh the list so a retry is not sent blind, and say so plainly
         instead of reporting a definite failure. */
      const dropped = err.uncertain || /connection dropped|before the send finished/i.test(err.message)
      if (dropped) {
        setRecent(null)
        try {
          setRecent((await get<SendView>('/api/send')).recent)
        } catch {
          view.reload()
        }
      } else view.reload()
      setResult({
        ok: false,
        uncertain: dropped && !err.body?.recent,
        text: dropped
          ? `${err.message} Check Recent sends below before retrying — the file may have gone.`
          : err.message
      })
    } finally {
      setStage('edit')
    }
  }

  const busy = stage !== 'edit'
  const rows = (recent ?? data?.recent ?? []).slice(0, 20)

  return (
    <Shell page="send" title="Send a file">
      <Toaster />

      <Section title="New send">
        {view.loading && !data ? (
          <div className="flex items-center gap-2 text-muted">
            <Spinner /> loading…
          </div>
        ) : !data ? (
          <Empty title="The page could not load">{view.error ?? 'No answer from the server.'}</Empty>
        ) : (
          <Card className="p-5 sm:p-6">
            <div className="grid gap-6">
              <Field
                label="To"
                hint={
                  recipients.length
                    ? 'Every chat and group on the Chats page. Type a name, a number or “group”.'
                    : 'No chats yet. A chat appears here once it is on the Chats page.'
                }
              >
                <Picker
                  ariaLabel="which chat"
                  placeholder="pick a chat or group…"
                  searchPlaceholder="type a name, a number or “group”…"
                  searchAfter={5}
                  disabled={busy}
                  value={target}
                  onChange={(v) => {
                    setTarget(v)
                    setResult(null)
                  }}
                  className="max-w-xl"
                  options={recipients.map((r) => ({
                    value: r.target,
                    label: r.name,
                    hint:
                      r.kind === 'group'
                        ? 'group'
                        : `chat${r.number ? ` · ${r.number}` : ''}${r.pending ? ' · has not written yet' : ''}`
                  }))}
                />
              </Field>

              <Field label="File">
                <div className="flex flex-col gap-3">
                  <Segmented
                    options={SOURCES}
                    value={source}
                    onChange={(v) => {
                      if (busy) return
                      setSource(v)
                      setResult(null)
                    }}
                    labels={{ upload: 'Upload', box: 'From Desktop' }}
                    className="self-start"
                  />

                  {source === 'upload' ? (
                    <div
                      onDragOver={(e) => {
                        e.preventDefault()
                        if (!busy) setDragging(true)
                      }}
                      onDragLeave={() => setDragging(false)}
                      onDrop={(e) => {
                        e.preventDefault()
                        setDragging(false)
                        if (!busy) choose(e.dataTransfer.files)
                      }}
                      className={cn(
                        'max-w-xl rounded-card border border-dashed px-4 py-4 transition-colors',
                        dragging ? 'border-accent bg-accent-soft' : 'border-line-strong bg-sunk/40'
                      )}
                    >
                      <input
                        ref={fileInput}
                        type="file"
                        className="sr-only"
                        tabIndex={-1}
                        aria-hidden
                        onChange={(e) => choose(e.target.files)}
                      />
                      {upload ? (
                        <div className="flex min-w-0 items-center gap-3">
                          <FileUp className="size-5 shrink-0 text-muted" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium text-ink">{upload.name}</span>
                            <span className="tnum block font-mono text-[0.75rem] text-muted">
                              {fileSize(upload.size)}
                            </span>
                          </span>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            aria-label={`remove ${upload.name}`}
                            onClick={() => {
                              setUpload(null)
                              if (fileInput.current) fileInput.current.value = ''
                            }}
                          >
                            <X />
                            Remove
                          </Button>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                          <Button disabled={busy} onClick={() => fileInput.current?.click()}>
                            <FileUp />
                            Choose a file
                          </Button>
                          <span className="text-[0.85rem] text-muted">or drop one here. Up to {fileSize(max)}.</span>
                        </div>
                      )}
                    </div>
                  ) : sendable.length ? (
                    <div className="max-w-xl">
                      <Picker
                        ariaLabel="which file"
                        placeholder="pick a file…"
                        searchPlaceholder="type part of the name…"
                        searchAfter={6}
                        disabled={busy}
                        value={boxPath}
                        onChange={(v) => {
                          setBoxPath(v)
                          setResult(null)
                        }}
                        options={sendable.map((f) => ({
                          value: f.path,
                          label: f.name,
                          hint: `${f.folder} · ${fileSize(f.size)} · ${ago(f.mtime)}`
                        }))}
                      />
                      <p className="m-0 mt-1.5 text-[0.78rem] text-faint">
                        Newest first, from{' '}
                        {(data.folders.length ? data.folders : ['Desktop', 'taildrop']).join(' and ')}.
                        {files.length > sendable.length
                          ? ` ${files.length - sendable.length} empty or over ${fileSize(max)} not shown.`
                          : ''}
                      </p>
                    </div>
                  ) : (
                    <Empty>
                      Nothing to send on the Desktop or in taildrop. Put the file there, then reload this page.
                    </Empty>
                  )}

                  {problem ? (
                    <p role="alert" className="m-0 text-[0.85rem] text-down">
                      {problem}
                    </p>
                  ) : null}
                </div>
              </Field>

              <Field label="Message (optional)" hint="Goes with the file, or right after it.">
                <Textarea
                  value={message}
                  rows={3}
                  maxLength={maxMessage}
                  disabled={busy}
                  placeholder="a line to go with it…"
                  aria-label="message"
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                    setMessage(e.target.value)
                    setResult(null)
                  }}
                  className="max-w-xl"
                />
              </Field>

              {picked && kind !== 'file' ? (
                <Toggle
                  checked={full}
                  disabled={busy}
                  onChange={setFull}
                  label="Full quality (send as document)"
                  hint={
                    full
                      ? `The ${kind} arrives exactly as it is, as a file.`
                      : `Sent as a ${kind}, which WhatsApp compresses.`
                  }
                />
              ) : picked ? (
                <p className="m-0 text-[0.85rem] text-muted">Sent as a document, so it arrives exactly as it is.</p>
              ) : null}

              {stage === 'confirm' && who && picked ? (
                <div
                  role="group"
                  aria-label="confirm the send"
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setStage('edit')
                  }}
                  className="rounded-card border border-line-strong bg-card-2 px-4 py-4 sm:px-5"
                >
                  <p className="m-0 font-serif text-[1.2rem] leading-snug text-ink">
                    Send <b className="font-medium break-all">{picked.name}</b>{' '}
                    <span className="tnum text-muted">({fileSize(picked.size)})</span> to{' '}
                    <b className="font-medium">{who.name}</b>?
                  </p>
                  <p className="m-0 mt-1.5 text-[0.85rem] text-muted">
                    {asDocument
                      ? kind === 'file'
                        ? 'As a document.'
                        : `As a document, at full quality.`
                      : `As a ${kind}, compressed by WhatsApp.`}
                    {message.trim() ? ' With your message.' : ' No message.'}
                  </p>
                  {message.trim() ? (
                    <p className="m-0 mt-2 line-clamp-3 max-w-prose border-l-2 border-line-strong pl-3 text-[0.88rem] text-read">
                      {message.trim()}
                    </p>
                  ) : null}
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button ref={cancelRef} variant="ghost" onClick={() => setStage('edit')}>
                      Cancel
                    </Button>
                    <Button variant="primary" onClick={() => void send()}>
                      <SendIcon />
                      Send
                    </Button>
                  </div>
                </div>
              ) : stage === 'sending' ? (
                <div role="status" className="flex max-w-xl flex-col gap-2">
                  <div className="flex items-center gap-2 text-[0.9rem] text-ink">
                    <Spinner />
                    {picked?.file && progress < 1
                      ? `Uploading… ${Math.round(progress * 100)}%`
                      : 'Sending to WhatsApp… a large file can take a few minutes.'}
                  </div>
                  {picked?.file ? (
                    <div className="h-1.5 overflow-hidden rounded-full bg-line">
                      <div
                        className="h-full rounded-full bg-accent transition-[width] duration-200"
                        style={{ width: `${Math.round(progress * 100)}%` }}
                      />
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="primary"
                    disabled={!ready}
                    onClick={() => {
                      setResult(null)
                      setStage('confirm')
                    }}
                  >
                    <SendIcon />
                    Review and send
                  </Button>
                  {!ready && !problem ? (
                    <span className="text-[0.82rem] text-faint">
                      {!who ? 'Pick a chat first.' : !picked ? 'Choose a file.' : ''}
                    </span>
                  ) : null}
                </div>
              )}

              {result ? (
                <div
                  role={result.ok ? 'status' : 'alert'}
                  className={cn(
                    'max-w-xl rounded-card border px-4 py-3 text-[0.9rem]',
                    result.ok
                      ? 'border-up/40 bg-up/10 text-ink'
                      : result.uncertain
                        ? 'border-warn/40 bg-warn/5 text-ink'
                        : 'border-down/40 bg-down/5 text-ink'
                  )}
                >
                  <b
                    className={cn(
                      'font-semibold',
                      result.ok ? 'text-up' : result.uncertain ? 'text-warn' : 'text-down'
                    )}
                  >
                    {result.ok ? 'Sent.' : result.uncertain ? 'Uncertain.' : 'Not sent.'}
                  </b>{' '}
                  {result.text}
                </div>
              ) : null}
            </div>
          </Card>
        )}
      </Section>

      <Section title="Recent sends">
        {!rows.length ? (
          <Empty>Nothing has been sent from this page yet.</Empty>
        ) : (
          <Card className="p-0">
            {rows.map((r, i) => (
              <div
                key={`${r.at}-${i}`}
                className="flex items-start gap-3 border-t border-line-2 px-5 py-3.5 first:border-t-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="m-0 truncate font-medium text-ink" title={r.name}>
                    {r.name}
                  </p>
                  <p className="m-0 mt-0.5 text-[0.82rem] text-muted">
                    to {r.recipient}
                    <span className="tnum"> · {fileSize(r.size)}</span>
                    {' · '}
                    <span title={when(r.at)}>{ago(r.at)}</span>
                  </p>
                  {!r.ok && r.error ? <p className="m-0 mt-1 text-[0.82rem] text-down">{r.error}</p> : null}
                </div>
                {r.ok ? (
                  <Badge tone="on" className="shrink-0">
                    sent
                  </Badge>
                ) : (
                  <Badge className="shrink-0 border-transparent bg-down/12 text-down">failed</Badge>
                )}
              </div>
            ))}
          </Card>
        )}
      </Section>
    </Shell>
  )
}
