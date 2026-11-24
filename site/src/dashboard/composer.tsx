import { useEffect, useRef, useState } from 'react'
import { get, post, OwnerRequestError } from '@/lib/api'
import type { CoreChat } from '@/lib/core'
import { chatHref } from './navigation'

type Outcome = 'acknowledged' | 'refused' | 'unknown'
type Receipt = { submissionId: string; outcome: Outcome }
function outcome(result: Receipt, id: string): Outcome {
  return result.submissionId === id && ['acknowledged', 'refused'].includes(result.outcome) ? result.outcome : 'unknown'
}

function newSubmissionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

export default function Composer({ chat }: { chat: CoreChat }) {
  const [draft, setDraft] = useState('')
  const [review, setReview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Outcome | null>(null)
  const [error, setError] = useState('')
  const key = 'aira-submission-' + chat.chatId
  const id = useRef<string | null>(null)
  const flight = useRef(false)
  const checking = useRef(false)
  const confirmed = useRef<string | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const receipt = useRef<HTMLParagraphElement>(null)
  const screen = result ?? (review ? 'review' : 'draft')
  const previousScreen = useRef(screen)
  useEffect(() => {
    if (previousScreen.current === screen) return
    previousScreen.current = screen
    const destination = screen === 'draft' ? input : screen === 'review' ? heading : receipt
    destination.current?.focus()
  }, [screen])
  const name = chat.label || (chat.type === 'group' ? 'Unnamed Group' : 'Unnamed Direct Chat')
  const text = draft.trim()
  const count = [...text].length
  const back = chatHref('chats/' + encodeURIComponent(chat.chatId) + '/settings')
  async function lookup(stored: string) {
    if (checking.current) return
    checking.current = true
    setError('')
    try {
      const response = await get<Receipt>('/api/messages/' + encodeURIComponent(stored))
      setResult(outcome(response, stored))
    } catch (error) {
      if (error instanceof OwnerRequestError && error.status === 404) {
        setResult(confirmed.current === null ? 'unknown' : null)
        setReview(confirmed.current !== null)
        setError(
          confirmed.current === null
            ? 'No receipt is available yet. Check the original submission again.'
            : 'No receipt is available. You can confirm the same message again using its original submission ID.'
        )
        return
      }
      setResult('unknown')
      setError('The status check failed. Check again before starting another message.')
    } finally {
      checking.current = false
    }
  }
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(key)
      if (stored) {
        id.current = stored
        setResult('unknown')
        void lookup(stored)
      }
    } catch {
      setError('Browser storage is unavailable. Enable it before confirming a message.')
    }
  }, [key])
  async function send() {
    if (flight.current || result || count < 1 || count > 4000) return
    const submissionId = id.current ?? newSubmissionId()
    try {
      sessionStorage.setItem(key, submissionId)
    } catch {
      setError('Browser storage is unavailable. The message was not submitted.')
      return
    }
    confirmed.current = text
    id.current = submissionId
    flight.current = true
    setBusy(true)
    setError('')
    try {
      const response = await post<Receipt>('/api/messages', { submissionId, chatId: chat.chatId, text })
      setResult(outcome(response, submissionId))
    } catch (error) {
      if (error instanceof OwnerRequestError && [400, 401, 403, 404, 413, 415, 503].includes(error.status))
        setResult('refused')
      else await lookup(submissionId)
    } finally {
      flight.current = false
      setBusy(false)
      setReview(false)
    }
  }
  function start() {
    try {
      sessionStorage.removeItem(key)
    } catch {
      setError('Browser storage is unavailable.')
      return
    }
    confirmed.current = null
    id.current = null
    if (result === 'acknowledged') setDraft('')
    setResult(null)
    setError('')
    setReview(false)
  }
  return (
    <section className="composer">
      <a href={back}>Chat Settings</a>
      <h1 ref={heading} tabIndex={-1}>
        {review ? 'Review Message' : 'Send Message'}
      </h1>
      <div className="compose-card">
        <span>To</span>
        <strong>{name}</strong>
        <small>{chat.chatId}</small>
        <small>{chat.type === 'group' ? 'WhatsApp Group' : 'WhatsApp Direct Chat'}</small>
        <p>Sent as written to this chat.</p>
        {!result &&
          (review ? (
            <>
              <h3>Message</h3>
              <p className="message-preview">{text}</p>
            </>
          ) : (
            <>
              <label htmlFor="message-text">Message</label>
              <textarea
                ref={input}
                id="message-text"
                readOnly={confirmed.current !== null}
                rows={7}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                aria-describedby="message-length"
                aria-invalid={count > 4000}
              />
              <small id="message-length">{count.toLocaleString()} / 4,000 Characters</small>
            </>
          ))}
        <p ref={receipt} tabIndex={-1} role="status">
          {busy
            ? 'Submitting…'
            : result === 'acknowledged'
              ? 'Gateway acknowledged the message.'
              : result === 'refused'
                ? 'The send was refused. Your draft is available to edit.'
                : result === 'unknown'
                  ? 'The send outcome is unknown.'
                  : ''}
        </p>
        {error && <p role="alert">{error}</p>}
        <div className="compose-actions">
          {result === 'unknown' ? (
            <button onClick={() => id.current && lookup(id.current)}>Check Status</button>
          ) : result ? (
            <button onClick={start}>{result === 'refused' ? 'Edit Draft' : 'New Message'}</button>
          ) : review ? (
            <>
              <button disabled={busy} onClick={() => setReview(false)}>
                Edit Message
              </button>
              <button disabled={busy} onClick={send}>
                Confirm Send
              </button>
            </>
          ) : (
            <>
              <a href={back}>Cancel</a>
              <button disabled={!count || count > 4000} onClick={() => setReview(true)}>
                Review Message
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
