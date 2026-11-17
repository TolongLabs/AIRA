// Turns each rendered diagram in .archify/ into a standalone SVG in docs/diagrams/.
// Render first: see docs/diagrams/README.md.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const SOURCES = 'docs/diagrams/src'
const RENDERED = '.archify'
const OUTPUT = 'docs/diagrams'

const STYLE = `
  svg { --ink: #1f2937; --muted: #5b6475; --faint: #9aa3b5; --line: #d5dbe6; --card: #ffffff;
    --blue: #4a67c0; --green: #17916a; --violet: #7a5cd6; --amber: #b9770f; --red: #bd3149;
    --mask: var(--card); --lane-stroke: var(--line);
    --frontend-stroke: var(--blue); --backend-stroke: var(--blue); --database-stroke: var(--green);
    --cloud-stroke: var(--violet); --security-stroke: var(--amber); --messagebus-stroke: var(--muted);
    --external-stroke: var(--muted);
    --frontend-fill: color-mix(in srgb, var(--frontend-stroke) 12%, var(--mask));
    --backend-fill: color-mix(in srgb, var(--backend-stroke) 12%, var(--mask));
    --database-fill: color-mix(in srgb, var(--database-stroke) 12%, var(--mask));
    --cloud-fill: color-mix(in srgb, var(--cloud-stroke) 12%, var(--mask));
    --security-fill: color-mix(in srgb, var(--security-stroke) 12%, var(--mask));
    --messagebus-fill: color-mix(in srgb, var(--messagebus-stroke) 12%, var(--mask));
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; letter-spacing: -0.01em; }
  @media (prefers-color-scheme: dark) {
    svg { --ink: #e8ecf5; --muted: #a3acc0; --faint: #5d667a; --line: #2c3342; --card: #11141b;
      --blue: #8aa2df; --green: #4ade80; --violet: #b58cff; --amber: #ffc247; --red: #ff6b81; } }
  .c-mask { fill: var(--mask); stroke: none; }
  .c-grid { fill: none; stroke: none; }
  .c-lane, .c-security-group { fill: none; stroke: var(--lane-stroke); }
  .c-frontend { fill: color-mix(in srgb, var(--frontend-stroke) 10%, var(--mask)); stroke: var(--frontend-stroke); }
  .c-backend { fill: color-mix(in srgb, var(--backend-stroke) 10%, var(--mask)); stroke: var(--backend-stroke); }
  .c-database { fill: color-mix(in srgb, var(--database-stroke) 10%, var(--mask)); stroke: var(--database-stroke); }
  .c-cloud { fill: color-mix(in srgb, var(--cloud-stroke) 10%, var(--mask)); stroke: var(--cloud-stroke); }
  .c-security { fill: color-mix(in srgb, var(--security-stroke) 10%, var(--mask)); stroke: var(--security-stroke); }
  .c-messagebus { fill: color-mix(in srgb, var(--messagebus-stroke) 8%, var(--mask)); stroke: var(--messagebus-stroke); }
  .c-external { fill: var(--mask); stroke: var(--external-stroke); }
  .a-default { fill: none; stroke: var(--muted); }
  .a-emphasis { fill: none; stroke: var(--blue); }
  .a-security { fill: none; stroke: var(--red); }
  .a-dashed { fill: none; stroke: var(--faint); stroke-dasharray: 5 4; }
  .m-default { fill: var(--muted); } .m-emphasis { fill: var(--blue); }
  .m-security { fill: var(--red); } .m-dashed { fill: var(--faint); }
  .t-primary { fill: var(--ink); } .t-muted, .t-edge-dashed { fill: var(--muted); }
  .t-backend, .t-frontend, .t-edge-emphasis { fill: var(--blue); }
  .t-cloud { fill: var(--violet); } .t-security { fill: var(--amber); } .t-database { fill: var(--green); }
  .t-edge-security { fill: var(--red); }
  .semantic-sigil { display: none; }
`

function exportOne(name) {
  const html = readFileSync(join(RENDERED, `${name}.html`), 'utf8')
  const start = html.indexOf('<svg viewBox')
  const end = html.indexOf('</svg>', start)
  if (start < 0 || end < 0) throw new Error(`${name}: no diagram found in the rendered page`)
  let svg = html.slice(start, end + '</svg>'.length)
  svg = svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ').replace(' data-animation="trace"', '')
  const defsEnd = svg.indexOf('</defs>')
  if (defsEnd < 0) throw new Error(`${name}: the diagram has no <defs> block`)
  svg = `${svg.slice(0, defsEnd)}<style>${STYLE}</style>${svg.slice(defsEnd)}`
  writeFileSync(join(OUTPUT, `${name}.svg`), `${svg}\n`)
  return name
}

const names = readdirSync(SOURCES)
  .filter((file) => file.endsWith('.json'))
  .map((file) => basename(file, '.json'))
for (const name of names) console.log(`exported ${exportOne(name)}`)
