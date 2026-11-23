import { useEffect, useState } from 'react'
import { core, type CoreCharacter } from '@/lib/core'

export default function Catalogue() {
  const [rows, setRows] = useState<CoreCharacter[] | null>(null)
  const [error, setError] = useState(false)
  const [query, setQuery] = useState('')
  useEffect(() => {
    let live = true
    core.characters().then(
      (data) => {
        if (live) setRows(data.characters)
      },
      () => {
        if (live) setError(true)
      }
    )
    return () => {
      live = false
    }
  }, [])
  const visible = rows?.filter((row) => row.displayName.toLowerCase().includes(query.toLowerCase()))
  return (
    <>
      <label>
        Search characters <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {error ? (
        <p role="alert">Characters unavailable.</p>
      ) : visible ? (
        <>
          {visible.length ? (
            <ul>
              {visible.map((row) => (
                <li key={row.id}>{row.displayName}</li>
              ))}
            </ul>
          ) : (
            <p>No matching characters.</p>
          )}
        </>
      ) : (
        <p role="status">Loading…</p>
      )}
    </>
  )
}
