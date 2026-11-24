# AIRA Web Design Contract

This document is the visual contract for the AIRA web console. It defines routes, shell
behavior, surfaces, type, and interaction rules so review and implementation share one reference.

[AIRA Design System (public, read-only)][aira-figma]

## Source of truth

The Figma file above is the design authority and holds three pages: Rules, Design System,
and Website. Rules states the principles and prohibitions behind every screen, Design System
carries the reusable tokens, components, and states, and Website holds the owner dashboard
and workflow states. The site starts directly on /overview. Where this file and Figma
disagree, Figma wins.

## Canvas and shell

Design targets desktop at 1440 by 810 and phone at 396 by 704. Desktop uses the full shell
with an expandable sidebar and multi-column content; phone collapses to a single column and
moves navigation into a drawer reached from the header. Intermediate widths interpolate
between these two arrangements without introducing a third.

The sidebar and content share a fixed viewport height. Content scrolls inside the workspace. Spacing and tonal
surfaces separate sections. Loading placeholders follow the geometry of the pending content.
The expanded sidebar measures 248 pixels and the compact rail 80 pixels, and both keep the
same order and active state. The Japanese-inspired robot head has a transparent background. Its ink is true black #000000 in Light
and true white #FFFFFF in Dark, with no coloured backplate and transparent cut-outs. It
sits to the left of the Brand text and the pairing stays fixed across themes and widths;
the compact rail keeps the glyph only. Mouse or keyboard focus crossfades the glyph to the
collapse icon, and the compact rail glyph expands in place. Activating it collapses or
expands the sidebar on the same route, preserving the current active route. The hit area
is 44 pixels and collapsing never depends on hover alone. On phone, the top glyph in the
header opens the drawer and the same glyph inside the drawer closes it. A theme control
lives in the sidebar. The active sidebar indicator uses the ObsidianUI Dashboard Shell shared-layout motion and follows the route. Reduced motion changes the indicator immediately.

## Destinations

The console has seven destinations sharing one shell: /overview, /chats, /characters,
/library, /automations, /markets, and /system. Overview is the first page at /overview:
health status, active and pending chats, the next routine, and one compact Library summary
in a responsive, full-width bento with service readiness, chat distribution, a scheduled agenda and library composition. Overview is compact and read-only and each card is
clickable, leading with one dominant diagnostic and smaller paired tools beside it.

Chats is a directory with per-chat settings at `/chats/:id/settings` across five groups:
Character, Reply, Features, Quiet Hours, and Access. A local value overrides the shared
default, and Use Default removes that override and returns the chat to inherited behavior.
The manual composer at `/chats/:id/send` is owner-authored plain text for one known group
or direct message with a 4000-code-point maximum. It is manual text sent without a model
call.

Characters is a searchable, filterable, sortable persona directory with Create and Import
actions and up to five compact persona cards per row. The three Website cover illustrations share one crop and caption layout. Per-persona tool wording is edited at `/characters/:id/footer`,
where labels run 1 to 40 UTF-16 code units and each persona holds up to 50 expressions. The
WhatsApp simulator opens in a new tab so previewing never loses editor state. Library holds
items and their graph, Automations pairs routines with session notices, Markets groups
watchlists with alerts and digests, and System gathers health, host settings, and appearance.

## Tables and bulk actions

Tables support multi-select with pagination once the page limit is exceeded, and selection
survives page changes within the view. Bulk actions appear in a viewport-centered bottom
island that is 36 pixels tall and visually thin, with 44-pixel hit areas and a 16-pixel
bottom inset. The island only offers actions relevant to its table and dismisses when
selection clears.

## Surfaces, layout, and modality

Appearance lives at /system/appearance for the dashboard owner and device, not per chat.
The base pair is white and black with a selectable static ASCII lattice or stipple,
ShaderGradient layer, or plain finish, while focus and reading surfaces sit above
that base plane. Navigation retains the shell during location changes. Reduced motion falls back to the static finish. Navigation uses white at 38 percent in light mode and smoked neutral at 43
percent in dark mode; content cards use white at 73 percent in light or charcoal at 82
percent in dark. Borders stay restrained and gutters shared, keeping the quiet bento base
plane calm. Each view leads with one dominant diagnostic (never a fake chart) and smaller
paired tools, stacking to a single column on phone.

Modals sit over a dimmed and blurred lower interface with a fill of 86 percent in light mode
and 91 percent in dark, and actions align right with Cancel first and primary last. Forms use
the shadcn field, label, description, and error pattern with custom controls layered on top.
Tabs use a tonal fill and heavier text for selection, visible keyboard focus, and arrow-key
navigation. The phone drawer uses a solid light fill, and motion, transparency, static
presentation, focus, and contrast follow reduced-motion and contrast guidelines throughout.

## Typography

Interface text uses Outfit, a free typeface under the SIL Open Font License, as the single UI
voice. Brand text uses Unbounded Bold weight 700 with +20% tracking (0.20em), reading
visually A I R A from source label AIRA. Headings use Title Case with leading labels.
Body sets at 14 pixels with 12-pixel labels, 24-pixel page titles, 18-pixel section
titles, and 36-pixel display sizes when a hero or major diagnostic calls for one. The
canonical specimens are [Google Fonts Outfit][gf-outfit] and
[Google Fonts Unbounded][gf-unbounded]. [Geist Mono][geist-mono]
is reserved for identifiers and code such as paths, keys, and literal values, never for
ordinary numbers or running prose.

## References

The [official shadcn Field][shadcn-field] documentation defines the field, label, description,
and error composition used by every form. The [shadcnstudio bento grid][bento-grid] reference
informs the shared-gutter card arrangements behind overview and diagnostics. The
[ruucm/shadergradient][shadergradient] repository is the source for the optional gradient
layer. Figma remains the visual authority; these references define component behavior behind
the visuals.

[aira-figma]: https://www.figma.com/design/dKIeSHnu62q0MAIN8aNMk0/AIRA-Design-System
[gf-outfit]: https://fonts.google.com/specimen/Outfit
[gf-unbounded]: https://fonts.google.com/specimen/Unbounded
[geist-mono]: https://vercel.com/geist/mono
[shadcn-field]: https://ui.shadcn.com/docs/components/field
[bento-grid]: https://shadcnstudio.com/blocks/bento-grid/bento-grid
[shadergradient]: https://github.com/ruucm/shadergradient
