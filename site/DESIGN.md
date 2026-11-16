# TolongAI — Design Contract (DESIGN.md)

**Status:** authoritative. This file is the pinned visual contract for the TolongAI web UI.
Per the owner's global convention, **DESIGN.md wins over anything in CLAUDE.md or in code
comments.** When code and this file disagree, change the code.

> **Amendment — 2026-08-18 (owner-directed, supersedes everything below it, including
> the 2026-08-15 amendment where the two disagree).**
> Renamed, repainted, and lit. Current law:
>
> - **Name**: the product is **TolongAI**. The wordmark is `TolongAI`, serif 400,
>   2.6rem, **flat `--ink`** — the gradient it briefly carried was owner-rejected. The
>   `未来` seal is retired with the Mirai name: it was the Japanese for "Mirai" and means
>   nothing beside the new one.
> - **Page heads are facts, never narration.** A head may be a numeric sentence
>   (`Shell hero`, figures in `--ink`, connecting words in `--muted`) but only where the
>   fact is instance-wide and survives scale: a price, a job count, node totals. The
>   dashboard's "N words filed … next she speaks in 30 min" was removed on exactly this
>   ground — one instance already serves six chats, and a first-person-singular narrator
>   describing "her" next message is a single-chat framing that breaks the moment a
>   second group exists. The same rule retired "Every chat she knows" and "What she
>   knows" as section titles.
> - **Dashboard composition**: a metric row of four `MetricCard`s (micro label, tinted
>   icon chip, display figure, caption) over the activity chart in a `lg:col-span-2`
>   main column, with a **Where to go next** rail of `NextCard`s beside it. A dashboard
>   that only reports is a dead end.
> - **Light palette** — the Luminous Command Center scheme carried over from
>   `autopilot-hackathon-finals`, adapted: ground `#f5f7ff` (cornflower-tinted white,
>   never flat grey), ink `#141a42` (deep navy), accent `#5b76c8` (the reference's
>   `#8aa2df` cornflower, darkened for AA on white), soft `#e6ecfb`, hairlines `#e8ebf2`,
>   muted `#5c648c` at ~45% L for AA on the tinted ground.
> - **Dark palette** — **stays OLED**: ground is pure `#000000` with near-black panes
>   (`#0a0a0d`/`#101014`), accent the unmuted cornflower `#8aa2df` on `#141a30`. Any
>   colour in the dark fill turns AMOLED into charcoal; there is none.
> - **Surfaces are liquid glass, not flat panels.** Three things together, and it fails
>   if any one is missing: a translucent fill (`--glass-fill`, `rgb(255 255 255 / .045)`
>   dark, `/ .72` light) so the lit ground shows through; `backdrop-filter: blur(--blur)
saturate(160%)` so what shows through is diffused rather than legible; and a specular
>   top edge plus the pane's own hairline, both in ONE box-shadow
>   (`inset 0 1px 0 var(--glass-hi), 0 0 0 1px var(--glass-edge)`). No `border` on a glass
>   surface — a border on top of the edge shadow reads as two outlines. Radius `14px`.
> - **The ground is lit.** A sketchboard dot grid on `body` (16px, `--dot` at
>   `--dot-alpha`), 2% paper grain over everything via `body::before` at `z-index:800`,
>   and a pointer trail: 16 discs, each chasing the one AHEAD of it, 208px head fading
>   to a 36px tail, moved by `transform` only, never through React state. The trail is
>   cornflower `--glow` in light and **neutral `#b9bdcc` at `--glow-gain: .55` in dark** —
>   on black the cornflower read as a light-blue wisp trailing the pointer, i.e. a
>   coloured object rather than light. Illumination is white; the tint belongs to
>   whatever it falls on.
>   Content sits above it with `.above-ambience`. The trail is disabled on
>   `pointer: coarse` only — a touch device would park it at the last tap.
> - **Section tabs are Layak's newspaper underline**, never a pill capsule: a full-width
>   hairline, `gap-x-7`, label in `--ink` when active and `--muted` when not, the count
>   inline in mono tabular figures, and a 2px `--accent` rule sitting on the hairline
>   under the active tab. A capsule of five options reads as a segmented CONTROL —
>   something you toggle — when the thing it does is navigate between views.
> - **The theme toggle has two states, not three.** "Auto" was a state whose button
>   could not say what the page currently looked like. The OS still decides the FIRST
>   paint, because an unset storage key falls through to the media query; it stops
>   deciding the moment anyone touches the control.
> - **No page blurbs.** A subtitle that restates its own tab label in a cuter voice is a
>   line of text between the reader and the thing they clicked.
> - Storage keys: `tolongai-theme` / `tolongai-token`, each migrating the `mirai-` and
>   `memento-` names. Wire header `X-TolongAI-Token`; the server also accepts
>   `X-Mirai-Token` so a cached bundle still authenticates.
>   Where any paragraph below names Mirai, 未来, indigo, `#fafafa`, flat cards, or "no
>   grain", read it through this amendment.

> **Amendment — 2026-08-15 (owner-directed, superseded in part by 2026-08-18 above).**
> The owner overrode the warm-monochrome palette in live review. Current law:
>
> - **AMOLED ground**: dark mode is pure black `#000000` with near-black lifted cards
>   (`#0d0d10`/`#15151a`); light mode `#fafafa`/`#ffffff`. No paper grain.
> - **Indigo accent**, not terracotta: dark `#8c9eff` on soft `#161c3a`; light `#4f46e5`
>   on soft `#e9e8fd`. Vivid data colors (song `#ffb054`, vocab `#4cc2ff`, gram `#b58cff`,
>   artist `#ff7a9c`, mem `#5fe0a8`).
> - **Wordmark**: `Mirai<span class="ki" lang="ja">未来</span>`, serif 400, **56px**,
>   seal at `.32em` superscript in accent; the brand is the largest text on every page.
> - **Header nav**: pill links (radius 999, 16px/500, active = accent on accent-soft),
>   header row `align-items:center`. The old 2px `aria-current` underline is retired.
> - **Favicon**: accent dot `#7c7ff2`.
> - **Root type**: `html{font-size:19px}` both systems — readers are older; err large.
> - Theme storage key: `mirai-theme` (migrates memento-theme/brain-theme).
>   Where any paragraph below names terracotta, warm-brown dark, 記, 29px, or the nav
>   underline, read it through this amendment.

**Taste source (authoritative):** the owner's own TolongLabs system — the "Layak editorial
scale: restrained warm palette, generous whitespace, hairline rules," as restated across
CukaiPandai, SahurHub, Layak, and build-my-deck's editorial theme. Its signature:
warm paper + warm near-black ink; **warm brown-black dark mode, never pure black** (the
owner already repudiated chroma-0 black once, in Layak); one burnt terracotta accent at
full strength on small elements only, 8–16% tints for fills; editorial **serif for
headings and big tabular numerals**; **mono for microlabels, kickers, and table headers**;
sans for body/UI; 1px hairlines instead of shadows; small radius; 4px spacing; mono-kicker
card anatomy; one accent "flood" per page; sub-perceptual paper grain; 44px touch targets,
`:focus-visible` rings, tonal scrollbars, reduced-motion respected. Sentence case, short
declarative microcopy, zero emoji.

**Aesthetic (non-negotiable):** warm-monochrome editorial minimalism. Flat — **no drop
shadows, ever.** One terracotta accent, used with discipline. Phone-first. No external
assets (no web fonts, no CDN, no remote images) — the serif/mono habits are expressed
through system stacks. Japanese text is the hero and gets the strongest contrast on the page.

**The core problem this resolves:** the site is currently two detached design systems — v1
"classic" pages generated by `scripts/brain/site.py`, and v2 "app" pages hand-written in
`mirai/`. They disagree on palette (classic dark = pure black + gold accent; app dark =
warm brown + terracotta), wordmark, nav set, theme storage key, radius scale, and shadows.
**v2 is already the owner's taste** — it reads like a self-contained port of the
Layak/CukaiPandai system. This spec canonizes v2's language, sharpens it toward the owner's
signature (mono labels, bigger serif titles, grain, flood), then expresses it through the
_classic token names_ so the generated pages recolor for free by editing string constants
in `site.py`. We do not build a third system.

**One rule to remember:** retuning the palette = editing the four `:root` blocks in
`site.py`'s `CSS` constant **and** the `:root` blocks in `ui/src/styles.css` with the
_same_ values per the mapping table in §1. Both systems must stay coherent — and the
proof is measured in a browser, not read off the source: the two shells drifted twice
while a comment claimed they matched.

---

## 1. Color — single source-of-truth palette, dual-named

Every row below is **one color with two token names**: the v2 (`mirai/styles.css`) name and
the classic (`site.py`) name. They must resolve to identical hex. Light + **warm** dark only —
**dark mode is never pure black** (warm brown-black, the owner's SahurHub `#1a140f` /
Layak "midnight-sepia" family). Pure `#000` and the gold `#e0b165` accent are retired: they
are the single biggest "different site" tell and are banned.

### 1a. Core palette

| Role                              | v2 name         | Classic name    | Light     | Warm dark |
| --------------------------------- | --------------- | --------------- | --------- | --------- |
| Page ground                       | `--paper`       | `--bg`          | `#faf7f2` | `#181512` |
| Card / raised fill                | `--card`        | `--raise`       | `#fffdf8` | `#1f1b16` |
| Primary ink                       | `--ink`         | `--fg`          | `#201c17` | `#ece5da` |
| Long-form reading ink             | `--read`        | `--read`        | `#5f5949` | `#c9c0b2` |
| Secondary text (meta/labels)      | `--muted`       | `--muted`       | `#8a8175` | `#948a7c` |
| Tertiary / decorative             | `--faint`       | `--faint`       | `#a89e90` | `#6f675c` |
| Hairline (the only border)        | `--line`        | `--line`        | `#e7e0d6` | `#2e2924` |
| Soft hairline (row separators)    | `--line2`       | `--line2`       | `#f0ebe2` | `#231f1a` |
| **Terracotta accent**             | `--accent`      | `--accent`      | `#b4552d` | `#c9713f` |
| Accent tint (≈12% wash for fills) | `--accent-soft` | `--accent-soft` | `#f4e6dc` | `#33231a` |
| Positive (muted olive)            | `--up`          | `--ok`          | `#4a7c59` | `#6f9a7c` |
| Negative (rust)                   | `--down`        | `--down`        | `#a84632` | `#c06a55` |
| Caution (mustard)                 | `--amber`       | `--warn`        | `#a87c32` | `#b99253` |
| Shadow                            | _(n/a)_         | `--shadow`      | `none`    | `none`    |

Notes:

- Terracotta `#b4552d`/`#c9713f` is dead-center of the owner's accent family
  (`#C23B4B` / `#b5503c` / `#d9a066`); the olive/rust/mustard semantics are the owner's
  "desaturated botanicals, never neon" habit. These values are locked.
- v2 currently ships `--card:#fdfaf5`/`#1d1915` and lacks `--read/--faint/--line2/--accent-soft`.
  **Update v2 to the refined values above and add the four missing aliases** so both systems
  match exactly.
- `--accent-soft` is the _only_ accent fill permitted (owner habit: full-strength accent on
  small elements, 8–16% alpha tints for fills — e.g. SahurHub `--accent-tint: rgba(...,0.16)`).
- `--shadow: none` in all four classic blocks flattens every generated page for free, because
  `site.py` already references `var(--shadow)` on cards.
- Classic must **add** `--down` (it only had `--ok`/`--warn`; hard-coded `#ff6b6b` danger and
  stale blue fallbacks `#7aa2f7`/`#8bb8ff` are deleted and replaced by `--down`/`--accent`).

### 1b. Language inks (classic pages — Japanese is the hero)

| Token  | Role                          | Light     | Warm dark |
| ------ | ----------------------------- | --------- | --------- |
| `--ja` | strongest ink on the page     | `#1a160f` | `#f5efe6` |
| `--zh` | ties to the warm ochre family | `#96602f` | `#d19a68` |
| `--en` | translation gloss             | `#4a463c` | `#b3aa9b` |

### 1c. Category hues (node types — data colors, desaturated into the warm field)

These are **chart/data tokens** in the owner's sense (Layak's chart-token habit): functional
coding, botanical saturation, never brand colors. Squint test: the page must read monochrome;
categories are legible only up close. Category color appears as **text color + a hue-tinted
hairline**, never as a solid fill.

| Token      | Family     | Light     | Warm dark |
| ---------- | ---------- | --------- | --------- |
| `--song`   | ochre      | `#a06b2e` | `#cf9d5c` |
| `--vocab`  | slate teal | `#4e7285` | `#86a8ba` |
| `--gram`   | dusty plum | `#786a94` | `#a89ac2` |
| `--artist` | clay       | `#9c5f51` | `#c08a7c` |
| `--mem`    | sage       | `#5d7a5f` | `#8dab90` |

### 1d. Accent discipline + the flood

Full-strength terracotta appears **only on small elements**: link/nav hover, `aria-current`
underline, the **one** primary button per view, focus rings, the 記 wordmark superscript,
selected/active markers, mono kickers that need emphasis. Never full-strength as a large fill.
Never category coding. Never decorative.

**The flood (one per page, optional):** the owner's hierarchy move is _one loud thing, not
many medium things_ (CukaiPandai `.dash-hero`). A page may give exactly one dominant element
a `--accent-soft` fill with a `1px solid color-mix(in srgb, var(--accent) 35%, var(--line))`
border. Everything else stays paper/card. The dashboard's Brain panel is the designated flood
(§8); no other page currently needs one.

- Contrast budget: accent on paper ≈ 4.6:1 (AA UI text OK); `--muted` ≈ 3.4:1 (meta/labels
  only); `--faint` ≈ 2.4:1 (decorative only — never load-bearing text).

### 1e. Paper grain (sub-perceptual texture)

Both stylesheets add the owner's signature grain: an **inline SVG fractal-noise data-URI**
on `body::before` (fixed, `pointer-events:none`, `z-index:-1`), `opacity: 0.025`,
`mix-blend-mode: soft-light`. Inline data-URI only (no external assets); identical snippet in
both files. It must be invisible at reading distance — if you can see it, halve the opacity.
Disabled inside the graph canvas.

---

## 2. Type system

Self-hosted system stacks only, CJK-aware (phone over Tailscale — iOS/Android glyph coverage
matters). These are the system-stack expression of the owner's Fraunces/Literata + Space Mono +
humanist-sans triad. Define all three tokens in **both** stylesheets:

```css
--serif:
  'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif CJK JP',
  'Noto Serif JP', serif;
--sans:
  system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', 'Hiragino Kaku Gothic ProN', 'Yu Gothic UI',
  'Noto Sans CJK JP', 'Noto Sans JP', sans-serif;
--mono: ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, 'Liberation Mono', monospace;
```

**Division of labor (the owner's triad):**

- **Serif** — headings and large numerals only. Never body text, never buttons.
- **Mono** — microlabels, kickers, panel headers, field labels, table headers, chips, meta
  stamps, schedules, and the Files editor. This is the signature that most separates the
  owner's system from generic "warm minimalism" — labels are mono, uppercase, tracked.
- **Sans** — all body and UI text.

Scale (base 16px):

| Role                                     | Face  | Size                                     | Weight | Line height | Notes                                                                                                                                         |
| ---------------------------------------- | ----- | ---------------------------------------- | ------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| H1 page title                            | serif | `clamp(1.75rem, 5vw, 2.75rem)` (28–44px) | 500    | 1.05        | `letter-spacing:-0.02em`; owns its full row — "the title tells you where you are before any panel competes"; JP titles may go one step larger |
| Mono kicker (above/below H1, card heads) | mono  | 0.6875rem (11px)                         | 500    | 1.2         | UPPERCASE, `letter-spacing:.16em`, `--muted`; category stamps ("Interface", "Entity")                                                         |
| Hero stat / display numeral              | serif | `clamp(1.9rem,5vw,2.6rem)`               | 400    | 0.95        | `font-variant-numeric: lining-nums tabular-nums`, `letter-spacing:-0.02em`                                                                    |
| H2 section                               | serif | 1.35rem                                  | 400    | 1.3         |                                                                                                                                               |
| Card / panel label                       | mono  | 0.6875rem (11px)                         | 500    | 1.2         | UPPERCASE, `.14em` tracking, `--muted` — restyle v2 `.panel-head h2` from sans to mono                                                        |
| UI body                                  | sans  | 0.95rem (15px)                           | 400    | 1.5         |                                                                                                                                               |
| Reading body (lyrics, notes)             | sans  | 1rem                                     | 400    | 1.8         | color `--read`; JP gets 1.9                                                                                                                   |
| Meta / captions                          | sans  | 0.78rem                                  | 400    | 1.45        | `--muted`                                                                                                                                     |
| Chips / micro                            | mono  | 0.7rem                                   | 500    | 1           | uppercase, `.08em` tracking                                                                                                                   |
| Numerals in tables / quotes              | serif | 1.35rem (22px)                           | 400    | 1.25        | tabular; as v2 `.quote .px`                                                                                                                   |
| Table headers                            | mono  | 0.6875rem                                | 500    | 1.2         | uppercase, `.08em` tracking, `--muted`                                                                                                        |
| Schedules / editable numerics            | mono  | 0.85rem                                  | 400    | 1.4         | `font-variant-numeric: tabular-nums`                                                                                                          |

Weights: sans **400 / 500 / 600 only — no 700.** Serif **400** (stats, wordmark, H2) and
**500** (page titles) only — size carries hierarchy, not boldness. Mono 400/500. Case habits:
headings sentence case; uppercase reserved exclusively for tiny tracked mono labels.
Classic body drops from 16px/1.65 to **15px/1.5 sans** for UI, but keeps 1rem/1.8 for the
reading surfaces (ruby lines, notes). Apply `--serif` to `.head h1`, `.ja-title`, and stat
numerals in `site.py`; apply `--mono` to its `.crumbs`, badges, table headers, and meta stamps.

**Page-head pattern (every page, both systems):** mono kicker (section stamp, e.g.
`LIBRARY · SONG`) above a large serif H1, then an optional one-sentence muted dek in sans.

---

## 3. Spacing, radius, hairlines, shadows, motion

- **Spacing scale (4px base):** `4 / 8 / 12 / 16 / 24 / 32 / 48 / 64`. Card padding 16px on
  phone, 20–24px ≥880px. Page gutter 20px. Bento gap 12px phone / 14px desktop. 32px between
  panel groups. Generous page-head whitespace: ≥40px above the H1 block on desktop. Classic's
  rem spacing normalizes onto this — treat `.7rem` grid gaps as 12px etc.
- **Containers:** app pages `1160px`; reading/narrow pages `900px` (`--narrow`). Classic's
  `62rem` wrap maps to the narrow container. `min-width:0` on every grid child.
- **Radius:** one token `--r: 6px` for cards, buttons, inputs (in the owner's 3–10px editorial
  range). `999px` for chips/pills. `50%` only for the 36px theme-toggle circle. Nothing else.
  This kills classic's mixed `.75/.7/.65/.6/.55/.5/.35rem` scale.
- **Hairlines:** `1px solid var(--line)` is the **only** border — border, not shadow, is the
  structural primitive. Row separators inside cards use `--line2` and run **full-bleed**
  (border-top on the row, card padding moved onto the rows, per the owner's row-list habit).
  The single exception to 1px is the `aria-current` nav underline (2px accent,
  `text-underline-offset:7px` — keep v2's treatment).
- **Shadows: none, all four blocks.** Elevation = the paper→card fill step + a hairline. Hover
  affordance = border-color shift to `color-mix(in srgb, var(--muted) 45%, var(--line))`, or
  text→accent. No `translateY` hovers. The sticky classic header keeps its `backdrop-filter`
  blur but loses its shadow.
- **Motion:** 140–260ms, `cubic-bezier(0.2, 0, 0, 1)` ease-out; fades and small slides only.
  Tokens `--dur: 180ms; --ease: cubic-bezier(0.2,0,0,1)` in both stylesheets.
  `@media (prefers-reduced-motion: reduce)` zeroes all transitions/animations except
  explicitly communicative motion (none currently qualifies).
- **Craft floor (all four repos ship all four — never skip):** 44px minimum touch targets on
  every interactive element; `:focus-visible { outline: 2px solid var(--accent);
outline-offset: 2px }` globally; thin tonal scrollbars (`scrollbar-width: thin;
scrollbar-color: var(--line) transparent` + matching `::-webkit-scrollbar` at 8px); the
  reduced-motion block above.

---

## 4. Shared components (both systems, identical shape)

**Card / panel.** `background:var(--card); border:1px solid var(--line); border-radius:var(--r)`.
Anatomy (the owner's card signature): head row with **mono uppercase kicker** (`--muted`) at
left and an optional right-aligned accent text-link (`all →`, 12.5px) at baseline; optionally
one short muted sentence of body copy explaining the card; then content. Big numbers inside
are serif, tabular, tight-tracked. Clickable cards shift border-color on hover — no transform,
no shadow. Retire classic's 3px colored left-border-per-type; category color moves to text +
hairline tint only.

**Chips.** Pill, `1px solid var(--line)`, transparent bg, `2px 10px`, **mono** 0.7rem uppercase
500, `.08em` tracking. Neutral chips: `--muted` text. Category chips (song/vocab/gram/artist/
mem): text in the category hue, border `color-mix(in srgb, <hue> 30%, var(--line))`. Colored
text on a hairline — never a solid colored fill. Classic keeps its reading+gloss payload on
the chip.

**Tables.** No vertical rules, no zebra. Header row = **mono** micro-label style +
`border-bottom:1px solid var(--line)`. Body rows separated by `--line2`. Numerals
right-aligned: serif tabular for display figures, **mono tabular** for editable cells and
schedules. Row hover: `background:color-mix(in srgb, var(--card) 55%, var(--paper))`.
Meta columns hide below 560px. Wide tables live in an `overflow-x:auto` wrapper — **the page
body never scrolls sideways.**

**Buttons.** Default = ghost: `1px solid var(--line)`, `--r`, sans 600 0.85rem, `8px 14px`,
`min-height:44px`; hover → border `--muted`-mix, text `--ink`. Primary = solid `--accent`,
`--paper`-colored text, **max one per view**. Destructive = ghost with `--down` text and
`--down`-mixed border on hover. No gradients, no shadows. Only size variant permitted: a 32px
compact for dense table rows (the one sanctioned sub-44px control; give it ≥44px hit area via
padding on phone).

**Segmented choice group** (new — the owner's settings primitive, SahurHub pattern). For any
enumerable setting (theme, style, temperament, lens): a grid of ghost buttons,
`min-height:44px`, one per option; the selected option gets `background:var(--accent-soft);
border-color:color-mix(in srgb, var(--accent) 35%, var(--line)); color:var(--ink)` +
`aria-pressed="true"`. Replaces bare `<select>`s wherever options ≤5 and visible space allows.

**Form fields** (this is the fix for the "scuffed" settings/cron pages). Input
`background:var(--paper)` — one fill-step _below_ the card it sits in (inset by fill, not
shadow) — `1px solid var(--line)`, `--r`, `10px 12px`, `min-height:44px`, sans 0.95rem. Focus:
`border-color:var(--accent)` + `outline:2px solid var(--accent-soft)`. Labels: **mono**
micro-label above the field, 6px gap. Field rows stack on phone, 2-col ≥640px. **This deletes
classic's `var(--card)`-referencing inputs that rendered transparent** (classic never defined
`--card`); they now reference `--paper`/`--line` correctly.

**Danger zone** (owner pattern). Destructive actions live in a bordered card:
`border:1px solid color-mix(in srgb, var(--down) 40%, var(--line))`, mono kicker `DANGER ZONE`
in `--down`, one plain-language warning sentence ending "This can't be undone.", ghost-`--down`
button. Two-step confirms stay (plan → confirm), no `window.prompt()`.

**Theme toggle.** One control, merged from both systems: v2's **3-state cycle**
(auto → light → dark, glyphs `◐ / ☀ / ☾`, sets/removes `data-theme` on `<html>`) inside
classic's 36px circular icon-only button (transparent until hover, `--faint` glyph, accent
focus ring, `active` scale .94; ≥44px hit area via padding). Storage: **one key
`mirai-theme`** (values `light`|`dark`; absent = auto). See §6.

**Wordmark.** One brand everywhere: **`Mirai未来`** — serif 400, terracotta superscript 記 with
`lang="ja"`. Retire メメント and the "second brain" tagline (the kanji seal carries the
meaning). See §5.

**Microcopy (owner's voice, everywhere).** Short declarative sentences that explain _why_ and
state defaults ("Phone is the default." / "Follow this device, or choose a mode."). Mono
kickers as category stamps. Sentence case. No emoji, no exclamation marks. Destructive =
plain warning + "This can't be undone."

---

## 5. The one shell

Rendered **byte-identically** by the Python `page()` shell in `site.py` and by the three
hand-written `mirai/*.html` heads. Anything in this section marked **[byte-consistent]** must
match character-for-character between the two so the pages are visually indistinguishable when
you cross from `/` into `/library/`.

### 5a. Shell template (abstract)

```html
<header class="shell-head">
  <!-- [byte-consistent] -->
  <a class="wordmark" href="/">Mirai<span class="ki" lang="ja">未来</span></a>
  <nav class="shell-nav" aria-label="primary">
    <a href="/" {aria-current="page" if section="" ="dashboard}">Dashboard</a>
    <a href="/library/" {aria-current if section in (library,songs,ideas)}>Library</a>
    <a href="/app/graph.html" {aria-current if section="" ="graph}">Graph</a>
    <a href="/cron.html" {aria-current if section="" ="cron}">Cron</a>
    <a href="/app/settings.html" {aria-current if section="" ="settings}">Settings</a>
  </nav>
  <button class="theme-btn" id="theme-btn" type="button" aria-label="theme">◐</button>
</header>

{if subnav}
<!-- Library section + Settings only -->
<nav class="shell-subnav" aria-label="section">{items; active gets aria-current="page"}</nav>
{endif}

<main class="wrap {narrow?}">
  {if crumbs}
  <nav class="crumbs" aria-label="breadcrumb">{crumbs}</nav>
  {endif} {page head: mono kicker + serif h1 + optional dek}
  <!-- §2 page-head pattern -->
  {body}
</main>

<footer class="shell-foot">{per-page footer; classic keeps its generated-timestamp line}</footer>
```

**Wordmark [byte-consistent]:** `Mirai` + `<span class="ki" lang="ja">未来</span>`, serif 400,
terracotta 記 as superscript. `href="/"`.

**Primary nav — 5 items, one row on a phone [byte-consistent]:**
`Dashboard · Library · Graph · Cron · Settings`, theme button pinned right.

- **Songs and Ideas demote to Library sub-navigation** (classic crumbs already treat Library as
  parent). 7 mixed items → 5 stable ones — inside the owner's 5–8 item nav budget.
- **Nav hrefs are root-absolute** (`/`, `/library/`, `/app/graph.html`, `/cron.html`,
  `/app/settings.html`). This retires the `{root}` relative-prefix machinery _for the nav only_
  — crumbs and body links keep `{root}`. Tradeoff: classic pages stop working via `file://`;
  they are only ever served by the Handler over Tailscale, so that's acceptable.

**Active state — one mechanism [byte-consistent]:** `aria-current="page"` only. Section-level
in the primary nav (a vocab node lights **Library**); page-level in the subnav. Styled once
(accent color + 2px accent underline, offset 7px — the horizontal expression of the owner's
accent-edge active state; rails use the accent left-border variant, §7). Never a second class
like `.on`.

**Subnav content:**

- Library section (every page under `/library/`): `Overview · Songs · Ideas` →
  `/library/`, `/library/songs.html`, `/library/ideas.html`. Node pages keep their crumbs _in
  addition_ (subnav = "where can I go", crumbs = "where am I").
- Settings: the settings rail/chip nav (see §7). Its Cron entry points to `/cron.html`.
- Dashboard, Graph, Cron: no subnav.

**Title pattern [byte-consistent]:** `{Page} · Mirai`. Adopt classic's pattern everywhere
(v2's `Mirai — page` is dropped).

**Favicon [byte-consistent]:** the v2 terracotta-dot SVG data URI on every page (retire the
🧠 emoji). Accent must read `#b4552d` in the SVG.

### 5b. Route map + the "/" resolution

**Dashboard owns `/`.** The classic tree mounts under **`/library/`**. Because every internal
classic link is `{root}`-relative, the whole generated tree moves without regenerating a single
page — the Handler strips the prefix (~3 lines in `do_GET`):

```python
if route == "/library":                      # 301 → /library/
    ...redirect...
if route.startswith("/library/"):
    self.path = route[len("/library"):] or "/index.html"   # then fall through to super()
```

| Route                                                          | Page                                   | System                                             | Nav active         |
| -------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------- | ------------------ |
| `/`                                                            | Dashboard                              | app (`mirai/index.html`)                           | Dashboard          |
| `/library/` → `index.html`                                     | Library home                           | classic                                            | Library › Overview |
| `/library/songs.html`                                          | Songs index                            | classic                                            | Library › Songs    |
| `/library/ideas.html`                                          | Ideas                                  | classic                                            | Library › Ideas    |
| `/library/songs/<artist>/<slug>.html`                          | Song node                              | classic                                            | Library › Songs    |
| `/library/vocab/*`, `/library/grammar/*`, `/library/artists/*` | Node pages                             | classic                                            | Library            |
| `/app/graph.html`                                              | Graph (live, lens tabs = page content) | app                                                | Graph              |
| `/cron.html`                                                   | Cron                                   | classic (stays at root — ops, not Library content) | Cron               |
| `/app/settings.html`                                           | Settings                               | app                                                | Settings           |

**Legacy 301s in the Handler:** `/index.html`→`/library/`, `/songs.html`→`/library/songs.html`,
`/ideas.html`→`/library/ideas.html`, `/graph.html`→`/app/graph.html`,
`/library/cron.html`→`/cron.html`, and old node paths `/vocab/*` `/grammar/*` `/artists/*`
`/songs/*` → the same path under `/library/`.

**One Graph:** `/app/graph.html` (live, API-fed) supersedes the baked classic graph. `site.py`
stops emitting the full classic `graph.html` and emits a meta-refresh redirect stub to
`/app/graph.html`.

**One Cron:** canonical page = `/cron.html` (classic, already API-backed). Settings' Cron subnav
entry links to `/cron.html`; the interim `settings.html#cron` section is flagged to eventually
merge into `/cron.html`.

---

## 6. One theme mechanism

Adopt v2's tri-state **auto → light → dark** (`◐ / ☀ / ☾`), single key **`mirai-theme`**
(`light`|`dark`; absent = auto), applied as `data-theme` on `<html>` over a
`prefers-color-scheme` baseline — the identical mechanism the owner ships in CukaiPandai and
SahurHub. Classic's binary `__t()` / `brain-theme` / `THEME_JS` is retired.

**Boot snippet — inline in `<head>` before CSS on _every_ page, both systems, pre-paint,
with one-time migration [byte-consistent]:**

```js
;(function () {
  var K = 'mirai-theme',
    old = localStorage.getItem('brain-theme')
  if (old && !localStorage.getItem(K)) localStorage.setItem(K, old) // brain-theme only held light/dark
  localStorage.removeItem('brain-theme')
  var t = localStorage.getItem(K)
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t)
})()
```

This replaces `THEME_JS` in `site.py` verbatim **and** is added as an inline `<script>` in the
three mirai heads (v2 currently applies theme too late — brief FOUC possible). The
button-cycling code becomes one shared implementation targeting `#theme-btn` in both systems:

```js
;(function () {
  var K = 'mirai-theme',
    r = document.documentElement,
    b = document.getElementById('theme-btn')
  function glyph() {
    var t = r.getAttribute('data-theme')
    b.textContent = t === 'light' ? '☀' : t === 'dark' ? '☾' : '◐'
  }
  glyph()
  b &&
    b.addEventListener('click', function () {
      var t = r.getAttribute('data-theme')
      if (!t) {
        r.setAttribute('data-theme', 'light')
        localStorage.setItem(K, 'light')
      } else if (t === 'light') {
        r.setAttribute('data-theme', 'dark')
        localStorage.setItem(K, 'dark')
      } else {
        r.removeAttribute('data-theme')
        localStorage.removeItem(K)
      } // back to auto
      glyph()
    })
})()
```

**Migration note:** users who set dark via the old classic `brain-theme` key keep their choice on
first load after deploy (the snippet copies then removes it). The values were always
`light`/`dark`, so they are value-compatible — no mapping table needed.

---

## 7. Settings page redesign (`/app/settings.html`)

**Chosen model: left rail + one-visible-panel, hash-routed; collapses to a sticky horizontally-
scrollable chip row on phone.** This is what GitHub / Linear / Notion / Stripe / Vercel all
converged on for settings; long-scroll scrollspy is **rejected** as the primary model (settings
sections are independent tasks with wildly unequal heights, and it fixes neither the Files-width
nor the off-screen-save-feedback problem). Panel _content_ follows the owner's settings anatomy:
per-topic cards with serif title + mono kicker + one explanatory sentence, segmented choice
groups with accent-tint selected state, and a bordered danger card. No server or build changes —
everything stays in the single `settings.html` + shared `styles.css`/`app.js`.

**Layout.**

- Desktop (≥880px): two-column grid `grid-template-columns: 180px minmax(0,1fr)`. Rail
  `position:sticky; top:68px`. Widen the wrap from 900px to **~1060px** — the freed width goes to
  Files and Cron. Only the active panel shows: `.panel:not(.is-active){display:none}`.
- Rail items: **mono** micro-labels. Active state: `--accent` text + a 2px accent left border —
  the owner's rail active state (CukaiPandai `.page-index-link[aria-current]`). Flat, no pill
  fill.
- Phone (<880px): the rail becomes a sticky, horizontally-scrollable chip row directly under the
  site header (`overflow-x:auto; scrollbar-width:none`; scroll the active chip into view on
  change; each chip ≥44px tall). One section per screen = hub-and-spoke. No new DOM.
- Deep links keep working: `/app/settings.html#cron` opens the Cron panel directly, which turns
  the duplicate nav entry into a legitimate deep link.

**Router (~15 lines vanilla, in `app.js`):**

```js
const panels = [...document.querySelectorAll('main .panel[id]')]
function route() {
  const id = (location.hash || '#bindings').slice(1)
  for (const p of panels) p.classList.toggle('is-active', p.id === id)
  for (const a of document.querySelectorAll('.subnav a'))
    a.setAttribute('aria-current', a.hash === '#' + id ? 'page' : 'false')
  document.querySelector(`.subnav a[href="#${id}"]`)?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
}
addEventListener('hashchange', route)
route()
```

**Rail order (most-touched first, editor last), with a muted count from the already-fetched `S`
object:** `Bindings · Proactive · Cron · Markets · Avatar · Home Assistant · Files`. Counts like
`Bindings 4`, `Cron 3 jobs`, `Markets 6 sym`. Optional mono group labels (Conversation /
Automation / System) — ordering is the load-bearing part, labels are optional.

**Panel anatomy (every section):** serif panel title + mono kicker at baseline + one short
muted sentence explaining what the section does and its default ("Choose a warm mode, or
follow this device."-class copy). Enumerable choices (Proactive style/temperament/mood,
Avatar mirror, alert direction) become **segmented choice groups** (§4) instead of bare
selects. Destructive actions (delete binding, remove job) collect the danger-card treatment.

**Save feedback — collapse three inconsistent models into two:**

1. **Autosave stays default** for single controls (Bindings selects, Proactive switches). Move
   the confirmation out of the per-panel `.note` span into **one fixed toast**
   (`position:fixed`, bottom-center phone / bottom-right desktop, `aria-live="polite"`, ~1.5s) —
   redirect the existing `flash()` helper. Survives long Cron lists where the panel head is
   off-screen.
2. **Explicit save keeps a dirty-state affordance** (scoped-down Polaris save bar): for Files,
   Home Assistant, and Markets alerts, when any input diverges from loaded state the section's
   Save button fills with `--accent` and the head shows "unsaved changes". Add `Ctrl/Cmd-S` in
   the Files textarea + a `beforeunload` guard when Files is dirty.
3. **Markets: kill the double button.** Debounce-autosave alerts on input (400ms); keep
   "Add alert" only for creating a row.

**Per-section layout:**

- **Bindings — real table.** CSS grid on the container so all rows share tracks:
  `grid-template-columns: minmax(0,1fr) auto auto auto auto auto` (chat / kind / personality /
  mode / agent / —), each `.brow` as `display:contents`, **mono** header row. Selects
  borderless-until-hover so it reads as text. Keep the pinned defaults row on top. Phone: each
  binding collapses to a card (chat id top line, controls in a 2-col grid). "Add binding"
  becomes a ghost last row (`+ add binding`) that expands.
- **Proactive — cards, tightened.** `.pcard` per key stays. Collapsed card gets a one-line
  summary (style · temperament · mood on/off). Style/temperament become segmented choice
  groups. Keep the `<details>` "advanced" disclosure with lazy-loaded values. Lay the 8 numeric
  knobs out with `grid-template-columns: repeat(auto-fill, minmax(110px,1fr))`, mono labels.
- **Cron — biggest winner from full width.** `.crow-top` becomes an aligned grid: name (serif) /
  schedule (**mono**, tabular) / status chip / "next …" right-aligned. Paused jobs dim to ~55%
  opacity. Keep the delivers-to `<details>` picker; each `.pick` row ≥44px tap target on phone.
  "New job" form stays at panel bottom, prompt textarea full width. Remove = danger treatment,
  "This can't be undone."
- **Markets — label the two subgroups.** Mono subheads `WATCHLIST` and `ALERTS`. Alerts `.tbl`
  gets right-aligned numeric inputs in **mono** with `font-variant-numeric: tabular-nums`
  (serif display numerals are for the dashboard, not inputs).
- **Avatar — leave small.** With one-panel-at-a-time it no longer looks broken. Model select +
  mirror as a segmented pair.
- **Home Assistant — keep the stub, small.** The write-only token field (password + "set ✓")
  already matches the secret pattern; add a muted hint "Paste to replace." when set.
  (Defensible option, flag-only: merge Avatar + Home Assistant into one "Integrations" panel for
  6 rail items — not required.)
- **Files — give the editor a real surface.** Full ~840px content column:
  `#f-text { width:100%; min-height:60vh; font-family:var(--mono); font-size:13px;
line-height:1.55; tab-size:2; resize:vertical; }`. kind/name selects + Save collapse into one
  compact `position:sticky` toolbar above the textarea, Save right-aligned with the dirty-dot.
  Phone: `min-height:55vh`.

Cost: ~80 lines CSS + ~25 lines JS, all in existing shared assets. The rail/chip primitive is
class-shell + tiny JS, so `site.py`'s `page()` can emit the same primitive for classic node
pages later without touching generated markup.

---

## 8. Dashboard bento (`/`) — redesign notes

- **Brain is the flood hero (§1d).** The current order leads with Markets (largest, first) and
  buries Brain (the actual node stats) last, below the phone fold. Invert: **Brain** becomes
  the page's one flood — `--accent-soft` fill, accent-mixed hairline, mono kicker
  `SECOND BRAIN`, serif display numerals, links into `/library/` — placed first in the bento.
  Markets stays but demotes to a regular card; every other panel stays paper-quiet.
- **Fix the cross-system exits:** the "Library" nav link and the Services panel's "cron" link
  currently jump into the old design system with zero warning. After §5, Library → `/library/`
  (now visually identical) and Services cron-link → `/cron.html` (the one canonical Cron).
  Remove the second Cron destination — one page owns Cron.
- **Header is the shared shell** (§5), so the 5-item nav no longer wraps to a second row eating
  first-screen height. Page head gets the §2 pattern (mono kicker + serif title).
- Panels adopt the shared card spec (§4): flat, hairline, mono panel labels, serif display
  numerals, `--r` radius, no shadow. Bento gap 12/14px. Microcopy pass per §4.

---

## 9. Graph page (`/app/graph.html`) — redesign notes

- **Default lens = `all`, not `ideas`.** Ideas currently has 0 nodes, so the page opens on an
  empty "No idea nodes yet" shrug while 334 nodes exist under All. Open on the populated view;
  keep Ideas/Library/All tabs — restyled as a segmented choice group (§4).
- **Repaint the canvas on the in-page theme toggle.** Today it reads CSS vars once and on
  `prefers-color-scheme` change only, so clicking `#theme-btn` leaves stale canvas colors until
  reload. Observe `data-theme` attribute changes on `<html>` (MutationObserver) and repaint.
- **Type colors follow the palette.** Move graph `TYPE_COLORS` onto the category hues in §1c
  (song `--song`, artist `--artist`, grammar/pattern `--gram`, vocab/word `--vocab`, idea/note
  `--mem`) read from CSS vars — no third hard-coded palette. The classic graph's always-dark
  `#141220` canvas + purple-navy sidebar (a third palette) is retired with the classic graph
  page. Legend labels in mono.
- **Add a lightweight inspector** so a click can show a node's connections without navigating
  away (classic solved this; the app regressed to click-navigates-immediately). Minimum: hover
  label stays; click opens a small side/inspect panel (card spec §4, mono kicker = node type)
  with the node link inside it. The legend becomes clickable to filter by type (it is currently
  `pointer-events:none`).
- No paper grain over the canvas (§1e).

---

## 10. Implementation checklist (ordered, file-mapped)

Do these in order. Items marked **[BC]** must be byte-consistent between the `site.py` `page()`
shell and the mirai static shells (§5) — diff them after editing.

**Phase A — palette + tokens (recolors everything).**

1. `scripts/brain/site.py` `CSS` constant, all four `:root` blocks (`:root`, the
   `@media(prefers-color-scheme:dark)`, `:root[data-theme=dark]`, `:root[data-theme=light]`):
   replace every hex with §1 values; set `--shadow:none` in all four; add `--down`,
   `--serif/--sans/--mono` (§2 CJK-aware stacks), `--r`, `--dur/--ease`; delete stale blue
   fallbacks `#7aa2f7/#8bb8ff` and hard-coded `#ff6b6b/#6bcf8f`.
2. `mirai/styles.css` `:root` + dark + both `[data-theme]` blocks: update to the refined §1
   hexes (`--card` → `#fffdf8`/`#1f1b16`); **add** `--read`, `--faint`, `--line2`,
   `--accent-soft`, `--r`, `--dur/--ease`; extend `--serif/--sans/--mono` with the §2 CJK
   fallbacks.
3. Both stylesheets: the §3 craft floor — global `:focus-visible` accent outline, thin tonal
   scrollbars, `prefers-reduced-motion` block, 44px touch minimums — and the §1e paper-grain
   `body::before` (identical inline SVG data-URI in both).
4. `scripts/brain/site.py`: apply `--serif` to `.head h1` (bumped to the §2 clamp, weight 500),
   `.ja-title`, and stat numerals; apply `--mono` to crumbs, badges, table headers, chips, and
   meta stamps; add the mono-kicker page-head pattern; drop classic body to 15px/1.5 sans for
   UI while keeping 1rem/1.8 for reading surfaces; replace the 3px colored type left-border on
   cards with the category-text + hairline-tint treatment (§4); fix `.cform` inputs to
   reference `--paper`/`--line` (they referenced the never-defined `--card`).
5. `mirai/styles.css`: restyle `.panel-head h2`, `.field > span`, `.tbl th`, `.chip` from
   sans to **mono** uppercase tracked (§2); bump page titles to the §2 serif clamp; normalize
   radius to `var(--r)` (+ `999px` chips, `50%` toggle); add the segmented-choice-group and
   danger-card component classes (§4).

**Phase B — one shell (visual unification).** 6. `scripts/brain/site.py` `NAV`/brand constant (~865): replace with the §5a shell — wordmark
`Mirai未来` **[BC]**, 5-item root-absolute nav **[BC]**, `#theme-btn` circular button **[BC]**;
drop `{root}` from nav hrefs only. Unify `<title>` to `{Page} · Mirai` **[BC]** and favicon
to the terracotta-dot SVG **[BC]**. 7. `scripts/brain/site.py` `page()` (~880): extend the `active` mapping to
`dashboard|library|songs|ideas|cron|graph|settings`; `songs`/`ideas` light **Library** in the
primary nav _and_ their subnav tab; render the Library subnav (`Overview · Songs · Ideas`) on
`/library/*` pages. 8. `mirai/index.html`, `mirai/graph.html`, `mirai/settings.html`: swap each header for the
shell **[BC]** (wordmark, 5-item nav order/links, drop the "second brain" tagline); make
Library link `/library/` and Cron link `/cron.html`; dashboard Services panel-link →
`/cron.html`.

**Phase C — theme (one mechanism).** 9. `scripts/brain/site.py`: replace `THEME_JS` (~477) with the §6 inline boot snippet **[BC]**
(in `<head>` before CSS) + the shared button-cycling code **[BC]** targeting `#theme-btn`.
Remove `__t()` and the `button.theme onclick="__t()"`. 10. `mirai/index.html`, `graph.html`, `settings.html`: add the §6 boot snippet inline in each
`<head>` before `styles.css` **[BC]**. 11. `mirai/app.js`: remove the theme _application_ (now in the head snippet); keep only the
shared button wiring targeting `#theme-btn`. No storage-key change — `mirai-theme` wins.

**Phase D — routing (`/` resolution).** 12. `scripts/brain/site.py` Handler `do_GET` (~2321): add the `/library/` prefix-strip mount +
the §5b legacy 301 table. Generated files do not move on disk; no page regeneration needed. 13. `scripts/brain/site.py` graph emit (~1917): stop writing the full classic `graph.html`;
write a meta-refresh redirect stub → `/app/graph.html`.

**Phase E — settings redesign.** 14. `mirai/styles.css`: add `.subnav`-as-rail styles (desktop 180px sticky rail with mono
labels + accent left-border active; phone chip row), `.panel:not(.is-active){display:none}`,
the fixed toast, dirty-state Save styling, and the per-section grids (Bindings table,
Proactive knob grid, Cron aligned grid, Markets mono subheads, Files editor surface). Widen
`.wrap.narrow` to ~1060px for the settings context. 15. `mirai/settings.html`: give each `section.panel` an `id`; restructure the `.subnav` as the
rail/chip nav with counts; panel heads get serif title + mono kicker + one-sentence
explanation (§7 anatomy, §4 microcopy); enumerable selects → segmented choice groups;
destructive actions → danger treatment; Bindings rows to `display:contents` grid; add the
sticky Files toolbar; label Markets subgroups; collapse Markets' double Save button to one. 16. `mirai/app.js`: add the §7 hash router; redirect `flash()` into the single fixed toast; add
dirty-state tracking (Files/HA/Markets) + `Ctrl/Cmd-S` + `beforeunload`; debounce-autosave
Markets alerts.

**Phase F — dashboard + graph polish.** 17. `mirai/index.html`: reorder the bento — Brain first as the `--accent-soft` flood hero
(§8), Markets demoted; panel heads to mono kickers; microcopy pass. 18. `mirai/graph.html`: default lens → `all`; lens tabs as segmented group; repaint canvas on
`data-theme` mutation; move `TYPE_COLORS` onto §1c category hues read from CSS vars; add the
click-inspector + clickable legend filter; exclude grain from the canvas area.

**Byte-consistency gate (before done):** diff the rendered `<head>` boot snippet, the
`<header class="shell-head">` block, the wordmark, the `<title>` pattern, and the favicon
between one `site.py`-generated page and `mirai/index.html`. They must be identical strings.
Then the squint test (§1c) and the grain test (§1e) on both a classic and an app page, in both
themes.
