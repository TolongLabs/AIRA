import { Loading } from '@/dashboard/loading'
import { useEffect, useMemo, useState, useRef, useLayoutEffect } from 'react'
import { core, type CoreCharacter } from '@/lib/core'
import { Input } from '@/components/ui'
import { FormSelect } from './form-select'
import { WorkspaceTools } from './workspace-tools'
import { studioHref, studioPaths } from './studio-client'
import { CreatePersona } from './studio-create'
import { motifs as covers, ProfileImage } from './profile-image'
import './selection-table.css'
import './studio.css'

type SourceFilter = 'all' | 'repository' | 'data'
type SortKey = 'name' | 'source' | 'language'

function matches(row: CoreCharacter, query: string): boolean {
  const hay = [row.displayName, row.id, ...(row.aliases ?? [])].join(' ').toLowerCase()
  return hay.includes(query.trim().toLowerCase())
}

export default function Catalogue() {
  const catalogue = useRef<HTMLElement>(null)
  const [columns, setColumns] = useState(5)
  const [page, setPage] = useState(() =>
    Math.max(1, Math.floor(Number(new URLSearchParams(location.search).get('page')) || 1))
  )
  useLayoutEffect(() => {
    const el = catalogue.current
    if (!el) return
    const update = () => {
      const w = el.clientWidth
      setColumns(w >= 780 ? 5 : w >= 560 ? 3 : 2)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const [rows, setRows] = useState<CoreCharacter[] | null>(null)
  const [faults, setFaults] = useState<{ id: string; reason: string }[]>([])
  const [error, setError] = useState(false)
  const params = new URLSearchParams(location.search)
  const [query, setQuery] = useState(params.get('search') ?? '')
  const [source, setSource] = useState<SourceFilter>((params.get('source') as SourceFilter) || 'all')
  const [sort, setSort] = useState<SortKey>((params.get('sort') as SortKey) || 'name')

  useEffect(() => {
    let live = true
    core
      .characters()
      .then((data) => {
        if (!live) return
        setRows(data.characters)
        setFaults(data.faults)
      })
      .catch(() => {
        if (live) setError(true)
      })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    const url = new URL(location.href)
    for (const [key, value] of [
      ['page', page > 1 ? String(page) : ''],
      ['search', query],
      ['source', source === 'all' ? '' : source],
      ['sort', sort === 'name' ? '' : sort]
    ]) {
      if (value) url.searchParams.set(key, value)
      else url.searchParams.delete(key)
    }
    history.replaceState(null, '', url)
  }, [page, query, source, sort])

  const artwork = useMemo(
    () =>
      new Map(
        (rows ?? [])
          .map((row) => row.id)
          .sort()
          .map((id, index) => [id, covers.find((cover) => cover === id) ?? covers[index % covers.length]])
      ),
    [rows]
  )
  const visible = useMemo(() => {
    const list = (rows ?? [])
      .filter((row) => (source === 'all' || row.source === source) && matches(row, query))
      .slice()
    if (sort === 'name') list.sort((a, b) => a.displayName.localeCompare(b.displayName))
    if (sort === 'source')
      list.sort((a, b) => a.source.localeCompare(b.source) || a.displayName.localeCompare(b.displayName))
    if (sort === 'language') list.sort((a, b) => (a.languages[0] ?? '').localeCompare(b.languages[0] ?? ''))
    return list
  }, [rows, query, source, sort])

  const pageSize = columns * 3
  const pages = Math.max(1, Math.ceil(visible.length / pageSize))
  const current = Math.min(page, pages)
  return (
    <section ref={catalogue} className="studio-catalogue" aria-label="Character studio">
      <WorkspaceTools>
        <CreatePersona />
      </WorkspaceTools>
      <div className="studio-catalogue-meta">
        <span>Persona Catalogue</span>
        {rows && (
          <span>
            {visible.length} {visible.length === 1 ? 'Persona' : 'Personas'}
          </span>
        )}
      </div>
      <div className="studio-controls" role="search">
        <Input
          type="search"
          aria-label="Search personas"
          value={query}
          placeholder="Search Personas"
          onChange={(event) => {
            setQuery(event.target.value)
            setPage(1)
          }}
        />
        <FormSelect<SourceFilter>
          label="Filter personas"
          value={source}
          onChange={(v) => {
            setSource(v)
            setPage(1)
          }}
          options={[
            { value: 'all', label: 'All sources' },
            { value: 'data', label: 'Editable' },
            { value: 'repository', label: 'Built-in' }
          ]}
        />
        <FormSelect<SortKey>
          label="Sort personas"
          value={sort}
          onChange={(v) => {
            setSort(v)
            setPage(1)
          }}
          options={[
            { value: 'name', label: 'Name' },
            { value: 'source', label: 'Source' },
            { value: 'language', label: 'Language' }
          ]}
        />
      </div>

      {error ? (
        <p role="alert">Characters unavailable. The core did not answer.</p>
      ) : !rows ? (
        <Loading layout="cards">Loading…</Loading>
      ) : (
        <>
          {!visible.length && <p>No matching characters.</p>}
          <ul className="studio-grid">
            {visible.slice((current - 1) * pageSize, current * pageSize).map((row) => (
              <li key={row.id} className="studio-card">
                <a className="studio-card-link" href={studioHref(studioPaths.edit(row.id))}>
                  <ProfileImage
                    kind="characters"
                    id={row.id}
                    configured={row.hasPortrait}
                    className="studio-art"
                    fallback={<img className="studio-art" alt="" src={`/app/dashboard/${artwork.get(row.id)}.svg`} />}
                  />
                  <div className="studio-card-meta">
                    <span className="studio-card-name">{row.displayName}</span>
                    <span>
                      {row.source === 'data' ? 'Data Pack' : 'Built-In'} ·{' '}
                      {row.languages.join(' · ') || 'No language set'}
                    </span>
                  </div>
                </a>
                {row.source === 'data' ? (
                  <a className="studio-card-links" href={studioHref(studioPaths.footer(row.id))}>
                    Tool wording
                  </a>
                ) : (
                  <span className="studio-card-links studio-readonly">Read Only</span>
                )}
              </li>
            ))}
          </ul>
          {pages > 1 && (
            <nav className="selection-pager" aria-label="Catalogue pages">
              <span aria-live="polite">
                {(current - 1) * pageSize + 1}–{Math.min(current * pageSize, visible.length)} of {visible.length}{' '}
                Personas
              </span>
              <button aria-label="Previous page" disabled={current === 1} onClick={() => setPage(current - 1)}>
                ‹
              </button>
              <span aria-current="page" className="selection-current">
                {current}
              </span>
              <button aria-label="Next page" disabled={current === pages} onClick={() => setPage(current + 1)}>
                ›
              </button>
            </nav>
          )}
          {!!faults.length && (
            <section className="studio-faults" aria-label="Packs that failed to load">
              <h2>Could not load</h2>
              <ul>
                {faults.map((fault) => (
                  <li key={fault.id}>
                    <strong>{fault.id}</strong> — {fault.reason}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </section>
  )
}
