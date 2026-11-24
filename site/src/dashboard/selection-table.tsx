import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useEffect, useLayoutEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import './selection-table.css'

export const SELECTION_PAGE_SIZE = 20

export type SelectionColumn<T> = {
  id: string
  header: string
  render: (row: T) => ReactNode
}

export type SelectionBulkAction<T> = {
  id: string
  label: string
  confirmMessage?: string
  primary?: boolean
  configure?: ReactNode
  confirmDisabled?: boolean
  onFinish?: () => Promise<void>
  run: (row: T) => Promise<void>
}

export type SelectionTableProps<T> = {
  rows: T[]
  getKey: (row: T) => string
  getRowLabel?: (row: T) => string
  columns: SelectionColumn<T>[]
  caption: string
  viewId: string
  bulkActions?: SelectionBulkAction<T>[]
  page: number
  pageSize?: number
  onPageChange: (page: number) => void
  emptyMessage?: string
}

type ActionResult = {
  label: string
  succeeded: number
  failures: { key: string; label: string; message: string }[]
}

function failureMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) return reason.message
  if (typeof reason === 'string' && reason) return reason
  return 'Unknown error'
}

export default function SelectionTable<T>({
  rows,
  getKey,
  getRowLabel,
  columns,
  caption,
  viewId,
  bulkActions = [],
  page,
  pageSize = SELECTION_PAGE_SIZE,
  onPageChange: setPage,
  emptyMessage = 'No matching rows.'
}: SelectionTableProps<T>) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [result, setResult] = useState<ActionResult | null>(null)
  const statusId = useId()
  const headerBox = useRef<HTMLInputElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const dialogTrigger = useRef<HTMLElement | null>(null)
  const configuration = useRef<HTMLSpanElement>(null)
  const restoreTarget = useRef<HTMLElement | null>(null)
  const previousView = useRef(viewId)

  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize))
  const safePage = Math.min(Math.max(1, page), pageCount)
  const visible = rows.slice((safePage - 1) * pageSize, safePage * pageSize)
  const visibleKeys = useMemo(() => visible.map(getKey), [visible, getKey])
  const lookup = useMemo(() => {
    const map = new Map<string, T>()
    for (const row of rows) map.set(getKey(row), row)
    return map
  }, [rows, getKey])

  useEffect(() => {
    if (previousView.current === viewId) return
    previousView.current = viewId
    setSelected(new Set())
    setPage(1)
    setPendingId(null)
    setResult(null)
  }, [viewId])

  const pagerChanged = useRef(false)
  function goToPage(target: number) {
    pagerChanged.current = true
    setPage(target)
  }
  useLayoutEffect(() => {
    if (!pagerChanged.current) return
    pagerChanged.current = false
    headerBox.current?.focus()
  }, [safePage])

  const visibleSelected = visibleKeys.filter((key) => selected.has(key))
  const allVisible = visibleKeys.length > 0 && visibleSelected.length === visibleKeys.length
  const someVisible = visibleSelected.length > 0 && !allVisible

  useEffect(() => {
    if (headerBox.current) headerBox.current.indeterminate = someVisible
  }, [someVisible])

  function labelFor(key: string): string {
    const row = lookup.get(key)
    if (row && getRowLabel) return getRowLabel(row)
    return key
  }

  function toggleRow(key: string, checked: boolean, trigger: HTMLElement) {
    restoreTarget.current = trigger
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(key)
      else next.delete(key)
      return next
    })
  }

  function toggleVisible(checked: boolean, trigger: HTMLElement) {
    restoreTarget.current = trigger
    setSelected((prev) => {
      const next = new Set(prev)
      for (const key of visibleKeys) {
        if (checked) next.add(key)
        else next.delete(key)
      }
      return next
    })
  }

  function focusRestoreTarget() {
    const target = restoreTarget.current
    if (target && document.contains(target)) target.focus()
    else headerBox.current?.focus()
  }

  function clearSelection() {
    setSelected(new Set())
    setPendingId(null)
    focusRestoreTarget()
  }

  async function dispatch(action: SelectionBulkAction<T>) {
    const keys = [...selected].filter((key) => lookup.has(key))
    if (!keys.length || runningId || action.confirmDisabled) return
    setPendingId(null)
    setRunningId(action.id)
    setResult(null)
    const succeeded = new Set<string>()
    const failures: ActionResult['failures'] = []
    for (const key of keys) {
      const row = lookup.get(key)
      if (!row) continue
      try {
        await action.run(row)
        succeeded.add(key)
      } catch (reason) {
        failures.push({ key, label: labelFor(key), message: failureMessage(reason) })
      }
    }
    await action.onFinish?.()
    setSelected((prev) => new Set([...prev].filter((key) => !succeeded.has(key))))
    setRunningId(null)
    setResult({ label: action.label, succeeded: succeeded.size, failures })
    if (succeeded.size === keys.length) headerBox.current?.focus()
  }

  const primary = bulkActions.find((action) => action.primary)
  const pending = bulkActions.find((action) => action.id === pendingId)

  function openPanel(id: string, trigger: HTMLElement) {
    dialogTrigger.current = trigger
    setPendingId(id)
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape' && !pendingId && selected.size > 0 && !runningId) {
      event.stopPropagation()
      clearSelection()
    }
  }

  return (
    <section className="selection-table" data-selected={selected.size > 0} aria-label={caption} onKeyDown={onKeyDown}>
      <div className="selection-scroll">
        <table aria-describedby={statusId}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th scope="col">
                <span className="selection-check">
                  <input
                    ref={headerBox}
                    type="checkbox"
                    checked={allVisible}
                    disabled={!visibleKeys.length}
                    onChange={(e) => toggleVisible(e.target.checked, e.currentTarget)}
                    aria-label={
                      visibleKeys.length
                        ? `Select this page (${visibleSelected.length} of ${visibleKeys.length} selected)`
                        : 'Select this page (no rows)'
                    }
                  />
                  <span aria-hidden="true" />
                </span>
              </th>
              {columns.map((col) => (
                <th key={col.id} scope="col" data-column={col.id}>
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const key = getKey(row)
              const checked = selected.has(key)
              return (
                <tr key={key}>
                  <td>
                    <span className="selection-check">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => toggleRow(key, e.target.checked, e.currentTarget)}
                        aria-label={'Select ' + labelFor(key)}
                      />
                      <span aria-hidden="true" />
                    </span>
                  </td>
                  {columns.map((col) => (
                    <td key={col.id} data-column={col.id}>
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {!rows.length && <p>{emptyMessage}</p>}
      {rows.length > 0 && (
        <div className="selection-pager" data-single={pageCount === 1}>
          <span aria-live="polite" aria-atomic="true">
            {(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, rows.length)} of {rows.length} Chats
          </span>
          <button type="button" disabled={safePage <= 1} onClick={() => goToPage(safePage - 1)}>
            <span aria-hidden="true">‹</span>
            <span className="sr-only">Previous page</span>
          </button>
          <span className="selection-current" aria-current="page">
            {safePage}
          </span>
          {safePage < pageCount && (
            <button type="button" aria-label={'Page ' + (safePage + 1)} onClick={() => goToPage(safePage + 1)}>
              {safePage + 1}
            </button>
          )}
          <button type="button" disabled={safePage >= pageCount} onClick={() => goToPage(safePage + 1)}>
            <span aria-hidden="true">›</span>
            <span className="sr-only">Next page</span>
          </button>
        </div>
      )}
      {selected.size > 0 && (
        <div className="selection-island" role="group" aria-label={selected.size + ' selected'}>
          <span className="selection-count">{selected.size} selected</span>
          <button type="button" disabled={!!runningId} onClick={(event) => openPanel('review', event.currentTarget)}>
            Review
          </button>
          {primary && (
            <button
              type="button"
              disabled={!!runningId}
              onClick={(event) => openPanel(primary.id, event.currentTarget)}
            >
              {primary.label}
            </button>
          )}
          <button type="button" disabled={!!runningId} onClick={clearSelection} aria-label="Clear selection">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}
      <Dialog.Root
        open={selected.size > 0 && pendingId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingId(null)
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dashboard-modal-scrim" />
          <Dialog.Content
            className="dashboard-modal"
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              const first = configuration.current?.querySelector<HTMLButtonElement>('button') ?? cancelButton.current
              first?.focus()
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              if (dialogTrigger.current?.isConnected) dialogTrigger.current.focus()
              else headerBox.current?.focus()
            }}
          >
            <Dialog.Title>{pending?.label ?? 'Review Selection'}</Dialog.Title>
            <Dialog.Description>
              {pending?.confirmMessage ?? 'Review the chats included in this selection.'}
            </Dialog.Description>
            <ul className="selection-review-list">
              {[...selected]
                .filter((key) => lookup.has(key))
                .map((key) => (
                  <li key={key}>{labelFor(key)}</li>
                ))}
            </ul>
            {pending?.configure && <span ref={configuration}>{pending.configure}</span>}
            <div className="dashboard-modal-actions">
              <Dialog.Close asChild>
                <button ref={cancelButton} type="button">
                  {pending ? 'Cancel' : 'Close'}
                </button>
              </Dialog.Close>
              {pending ? (
                <button
                  type="button"
                  disabled={!!runningId || pending.confirmDisabled}
                  onClick={() => void dispatch(pending)}
                >
                  Confirm {pending.label}
                </button>
              ) : (
                bulkActions
                  .filter((action) => !action.primary)
                  .map((action) => (
                    <button key={action.id} type="button" onClick={() => setPendingId(action.id)}>
                      {action.label}
                    </button>
                  ))
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <div id={statusId} className="selection-status" role="status">
        {selected.size > 0 ? selected.size + ' selected. ' : ''}
        {result
          ? result.label +
            ': ' +
            result.succeeded +
            ' succeeded' +
            (result.failures.length ? ', ' + result.failures.length + ' failed and kept selected for review.' : '.')
          : ''}
      </div>
      {result && result.failures.length > 0 && (
        <ul className="selection-failures" aria-label="Rows needing review">
          {result.failures.map((failure) => (
            <li key={failure.key}>
              {failure.label}: {failure.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
