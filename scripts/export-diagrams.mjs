// Turns each rendered diagram in .archify/ into a standalone SVG in docs/diagrams/.
// Render first: see docs/diagrams/README.md.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const SOURCES = 'docs/diagrams/src'
const RENDERED = '.archify'
const OUTPUT = 'docs/diagrams'

const outfit = readFileSync('site/public/dashboard/fonts/outfit.woff2').toString('base64')
const STYLE = `
  @font-face { font-family: Outfit; font-weight: 100 900; src: url(data:font/woff2;base64,${outfit}) format('woff2'); }
  svg { --ink: #102725; --muted: #445c59; --faint: #637976; --line: #a2b6b2; --card: #ffffff;
    --blue: #00665e; --green: #24643b; --violet: #645185; --amber: #804e09; --red: #9e3043;
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
    --external-fill: var(--mask);
    --text: var(--ink); --text-muted: var(--muted);
    --arrow: var(--muted); --arrow-emphasis: var(--blue);
    font-family: Outfit, Arial, sans-serif; letter-spacing: -0.01em; }
  @media (prefers-color-scheme: dark) {
    svg { --ink: #eff7f5; --muted: #b7cbc7; --faint: #879c98; --line: #4b615d; --card: #111b1a;
      --blue: #89d8cb; --green: #8bd2a1; --violet: #c6b3df; --amber: #f1c074; --red: #ff9ba7; } }
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
  .c-page { fill: var(--card); stroke: none; }
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
  // An opaque page in the diagram's own palette keeps it readable on any page theme: an <img> follows the
  // reader's system colour scheme, not the GitHub theme around it.
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1].split(/[\s,]+/)
  if (!viewBox) throw new Error(`${name}: the diagram has no viewBox`)
  const [x, y, width, height] = viewBox
  const afterDefs = svg.indexOf('</defs>') + '</defs>'.length
  const page = `<rect class="c-page" x="${x}" y="${y}" width="${width}" height="${height}"/>`
  svg = `${svg.slice(0, afterDefs)}${page}${svg.slice(afterDefs)}`
  writeFileSync(join(OUTPUT, `${name}.svg`), `${svg}\n`)
  return name
}

const names = readdirSync(SOURCES)
  .filter((file) => file.endsWith('.json'))
  .map((file) => basename(file, '.json'))
for (const name of names) console.log(`exported ${exportOne(name)}`)
