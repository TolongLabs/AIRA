import { useEffect, useId, useMemo, useRef, useState } from 'react'
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
  page:number
  onPageChange:(page:number)=>void
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
  page, onPageChange:setPage,
  emptyMessage = 'No matching rows.'
}: SelectionTableProps<T>) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [result, setResult] = useState<ActionResult | null>(null)
  const statusId = useId()
  const headerBox = useRef<HTMLInputElement>(null)
  const confirmButton = useRef<HTMLButtonElement>(null)
  const restoreTarget = useRef<HTMLElement | null>(null)
  const previousView = useRef(viewId)

  const pageCount = Math.max(1, Math.ceil(rows.length / SELECTION_PAGE_SIZE))
  const safePage = Math.min(Math.max(1, page), pageCount)
  const visible = rows.slice((safePage - 1) * SELECTION_PAGE_SIZE, safePage * SELECTION_PAGE_SIZE)
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

  useEffect(() => {
    if (pendingId) confirmButton.current?.focus()
  }, [pendingId])

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

  function cancelPending() {
    setPendingId(null)
    focusRestoreTarget()
  }

  async function dispatch(action: SelectionBulkAction<T>) {
    const trigger = document.activeElement as HTMLElement | null
    const keys = [...selected].filter((key) => lookup.has(key))
    if (!keys.length || runningId) return
    setPendingId(null)
    setRunningId(action.id)
    setResult(null)
    const succeeded=new Set<string>()
    const failures:ActionResult['failures']=[]
    for(const key of keys){
      const row=lookup.get(key)
      if(!row)continue
      try{await action.run(row);succeeded.add(key)}
      catch(reason){failures.push({key,label:labelFor(key),message:failureMessage(reason)})}
    }
    setSelected((prev) => new Set([...prev].filter((key) => !succeeded.has(key))))
    setRunningId(null)
    setResult({ label: action.label, succeeded: succeeded.size, failures })
    if (trigger && document.contains(trigger)) trigger.focus()
  }

  function arm(action: SelectionBulkAction<T>, trigger: HTMLButtonElement) {
    if (runningId) return
    if (action.confirmMessage && pendingId !== action.id) {
      restoreTarget.current = trigger
      setPendingId(action.id)
      return
    }
    void dispatch(action)
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape') return
    if (pendingId) {
      event.stopPropagation()
      cancelPending()
    } else if (selected.size > 0 && !runningId) {
      event.stopPropagation()
      clearSelection()
    }
  }

  return (
    <section className="selection-table" aria-label={caption} onKeyDown={onKeyDown}>
      <div className="selection-scroll">
        <table aria-describedby={statusId}>
          <caption>{caption}</caption>
          <thead>
            <tr>
              <th scope="col">
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
              </th>
              {columns.map((col) => (
                <th key={col.id} scope="col">
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
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => toggleRow(key, e.target.checked, e.currentTarget)}
                      aria-label={'Select ' + labelFor(key)}
                    />
                  </td>
                  {columns.map((col) => (
                    <td key={col.id}>{col.render(row)}</td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {!rows.length && <p>{emptyMessage}</p>}
      {rows.length > 0 && (
        <div className="selection-pager">
          <span>
            {SELECTION_PAGE_SIZE} per page · Page {safePage} of {pageCount}
          </span>
          <button type="button" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>
            Previous
          </button>
          <button type="button" disabled={safePage >= pageCount} onClick={() => setPage(safePage + 1)}>
            Next
          </button>
        </div>
      )}
      {selected.size > 0 && (
        <div className="selection-island" role="group" aria-label={selected.size + ' selected'}>
          <span className="selection-count">{selected.size} selected</span>
          {bulkActions.map((action) =>
            pendingId === action.id && action.confirmMessage ? (
              <span key={action.id} className="selection-confirm">
                <span>{action.confirmMessage}</span>
                <button
                  ref={confirmButton}
                  type="button"
                  disabled={runningId !== null}
                  onClick={() => void dispatch(action)}
                >
                  Confirm {action.label}
                </button>
                <button type="button" disabled={runningId !== null} onClick={cancelPending}>
                  Cancel
                </button>
              </span>
            ) : (
              <button
                key={action.id}
                type="button"
                disabled={runningId !== null}
                onClick={(e) => arm(action, e.currentTarget)}
              >
                {runningId === action.id ? action.label + '…' : action.label}
              </button>
            )
          )}
          <button type="button" disabled={runningId !== null} onClick={clearSelection}>
            Clear
          </button>
        </div>
      )}
      <div id={statusId} className="selection-status" role="status">
        {selected.size > 0 ? selected.size + ' selected. ' : ''}
        {result
          ? result.label +
            ': ' +
            result.succeeded +
            ' succeeded' +
            (result.failures.length
              ? ', ' + result.failures.length + ' failed and kept selected for review.'
              : '.')
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
