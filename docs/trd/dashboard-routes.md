# Dashboard route parity

Use the seven destinations in [the design contract](../DESIGN.md). In the table, legacy filenames are under
/app/. Frame numbers identify nodes on the Website page of the approved Figma file. Candidate paths are logical
routes. During preview, the core serves them under a separate mount while the existing /app/ entry serves traffic.

| Current entry                  | Owner task                                                          | Destination                    | Authority                                            | Representative frame      | Acceptance journey                                                 | Child      |
| ------------------------------ | ------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------- | ------------------------- | ------------------------------------------------------------------ | ---------- |
| index.html                     | Inspect service health, chat activity, upcoming routine and library | /overview                      | Host dashboard, core chat directory and host library | 4:385                     | Open each summary by keyboard and return through history           | #369       |
| index.html                     | Inspect or restart a service                                        | /system/health                 | Host service manager                                 | 22:204, 37:3634           | Confirm action and check resulting unit state                      | #370       |
| chats.html                     | Find active or pending group or DM                                  | /chats                         | Core chat table and gateway directory                | 22:661, 62:59438          | Search, page, select and return to filtered results                | #367       |
| chats.html                     | Set character, reply, features, quiet hours or access               | /chats/:id/settings            | Core setting hierarchy and chat record               | 62:59096, 43:6308         | Clear override, reload, verify source and next turn                | #367       |
| chats.html                     | Manage shared defaults                                              | /chats/defaults                | Global and type settings                             | 36:3437                   | Set a default and read effective value on a chat                   | #367       |
| send.html                      | Choose target, attach file, reconcile recent send                   | /chats/:id/settings#send       | Host upload and send history                         | 35:3030, 43:10290         | Retain file workflow and reconcile dropped response                | #367       |
| New                            | Send confirmed owner text to one chat                               | /chats/:id/settings#send       | Protected core operation and gateway acknowledgement | 111:133187, 111:134045    | Restart after lost acknowledgement and look up original submission | #360, #367 |
| chats.html footer editor       | Configure a persona tool label                                      | /characters/:id/footer         | Writable pack plus registered tools                  | 43:17174, 109:124266      | Save, clear, run simulated turn                                    | #368       |
| New                            | Browse, create, import, edit or simulate a persona                  | /characters                    | Pack loader and writable data packs                  | 29:1000, 35:1764, 35:1963 | Publish and select in a chat, preserve draft on preview            | #368       |
| library.html                   | Browse items and inspect authorized media                           | /library and /library/item/:id | Host library and owner media                         | 22:1543                   | Open item, refresh, refuse unauthorized media                      | #369       |
| graph.html                     | Explore linked items                                                | /library/graph                 | Host graph                                           | 35:2162                   | Open node, follow related item and return                          | #369       |
| cron.html                      | Inspect, edit, run or remove a routine                              | /automations/routines          | Host scheduler and core-scoped jobs                  | 22:1102, 35:2377          | Preserve unedited schedule and refuse protected jobs               | #370       |
| notices.html                   | Route coding session notices                                        | /automations/notices           | Host notice routes                                   | 30:1557                   | Set route and verify reloaded destination                          | #370       |
| markets.html and settings.html | Inspect markets, edit watchlists, alerts and digest                 | /markets                       | Host market reads and core market writer             | 30:1182, 35:2620          | Exercise stale edit, inherited list and independent recipients     | #369       |
| settings.html                  | Edit host models, voice, files and other owner settings             | /system/settings               | Host owner API                                       | 35:2791                   | Save, read back and retain dirty file on refusal                   | #370       |
| Theme control                  | Set theme, backdrop and rail                                        | /system/appearance             | Device preferences                                   | 145:176957                | Refresh, check storage migration and reduced motion                | #365, #370 |

Reply Models shows the running primary and fallback and the host's saved routing choices. The AIRA router
service and the current core's Claude Code runner have separate readiness checks. An unavailable route is
disabled in both selectors. Core Configuration edits installed YAML fields by group. Credentials offers
empty, write-only replacement fields and confirms removal. An explicit Apply saved changes restarts the
current image. The host retains the last working files for recovery.

## Middleware acceptance

Keep /api/ and /owner-api/ outside the page router. Missing assets return 404. Revalidate HTML on every load and
cache fingerprinted assets by content. Exercise HEAD, cold navigation, refresh, browser back and a deleted record
through the production listener. Resolve a targetless legacy send bookmark through an explicit chat picker.

## Legacy bookmarks and operations

Resolve fragments in the browser. The server receives only the path and query. Preserve internal chat IDs and
item IDs through validated route parameters. Keep a target picker for a send bookmark without an ID.

| Source    | Bookmark or workflow                                                      | Destination and verification                                                                                                                                                     |
| --------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings  | #chats, #bindings, #proactive, #cron                                      | Route the first three to /chats and the last to /automations/routines. Test each on initial load.                                                                                |
| Settings  | #models, #avatar, #voice, #home, #files                                   | Open the matching tab under /system/settings. Verify probe, model refresh, search provider, learning and lessons, voice settings, home toggle and dirty profile file navigation. |
| Settings  | #markets                                                                  | Open market preferences. Verify default and per-chat watchlists with inheritance, alert destinations and digest hours.                                                           |
| Library   | #type, #/type:id and encoded item hashes                                  | Select category or detail, retain search and follow media with owner authorization. Verify edit and forget confirmation.                                                         |
| Graph     | Lens, node search and inspector                                           | /library/graph links to item detail and Chats. Verify focus restoration on closing the inspector.                                                                                |
| Dashboard | Vocabulary, songs, grammar, people, topic, project and note links         | Preserve the corresponding Library category. Preserve the System service confirmation and readback.                                                                              |
| Chats     | #chat- followed by internal chat ID                                       | Open /chats/:id/settings, support deleted records, and preserve the directory return state.                                                                                      |
| Markets   | History ranges, quote refresh, news and generation                        | Keep lookup, refresh and generated summaries under /markets. Distinguish upstream error from no quotes.                                                                          |
| Send      | Upload, Desktop or taildrop source, options, progress and history         | Keep file selection, target selection, confirmation and recent-send reconciliation.                                                                                              |
| Notices   | Current activity, routes, quiet chats, route creation and machine reports | /automations/notices. Verify quiet release and reread persisted notice destination.                                                                                              |
| Routines  | List, archive, create, edit, run, rename, pause and remove                | /automations/routines. Preserve custom schedule and full prompt on unrelated edit; prevent managed-job mutation.                                                                 |

The current navigation and build entries live in site/src/components/shell.tsx and site/vite.config.ts.
Chats uses site/src/lib/core.ts for direct core requests. Other pages use site/src/lib/api.ts to translate
their /api/ paths to /owner-api/. Test the two incompatible chat response types independently.
Classic paths outside /app/ returned 404 on the legacy core listener, apart from the root redirect.

## Legacy performance baseline

At 09cc8ed, seven fresh Chromium contexts loaded the production dashboard at 1440 × 810 on the same workstation,
with loopback fixture responses for dashboard and cron, one active gateway service, three songs and two activity samples, and third-party
requests blocked. Navigation-to-render includes Playwright's wait for the service summary. The scrolling sample
uses thirty animation frames advancing 30 CSS pixels per frame. Repeat with the same fixture, runner and browser.

| Metric                                                              | Legacy median | Candidate upper limit |
| ------------------------------------------------------------------- | ------------: | --------------------: |
| Navigation load event                                               |        119 ms |                150 ms |
| Navigation to service summary                                       |        325 ms |                407 ms |
| Decoded first-route JavaScript                                      | 677,931 bytes |         677,931 bytes |
| Per-run 95th percentile scroll frame interval, median of seven runs |         83 ms |                 84 ms |

The time budget allows 25 percent variation rounded up for navigation. The first-route byte budget permits no
growth. The frame budget allows rounding to a whole millisecond. Measure again on the same device before cutover.
These figures cover the synthetic Overview journey only.

A local preview measurement at the same viewport and with the same seven-run fixture produced medians of 109 ms
for load, 280 ms for the service summary, 281,509 decoded JavaScript bytes and 17 ms for the scrolling frame interval.
Repeat against the integrated release candidate before switching the private entry.

## Interaction changes

| Owner task                      | Classic entry                                               | Dashboard preview                                                                                | Why                                                                      |
| ------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Select a chat                   | Open the chat-management page and find a target.            | Search and page through chats. Review the selected target before confirming a text submission.   | An owner can verify the recipient separately from the message.           |
| Check an uncertain submission   | Reopening the composer loses the immediate request outcome. | The status view looks up the submission ID after refresh. An unknown outcome stays visible.      | A lost acknowledgment requires reconciliation before another submission. |
| Navigate on a phone             | Open a destination through the legacy page navigation.      | Open the navigation drawer, choose a destination, or dismiss it and return focus to the trigger. | Keyboard users can return to the control that opened the drawer.         |
| Follow a stale routine bookmark | Open the schedule and search for the linked routine.        | Re-read the schedule before reporting removal. Show Retry when the service is unavailable.       | Owners can distinguish a removed routine from a temporary host failure.  |

After keyboard graph access, bookmark translation and the conflict editors were integrated, the same seven-run
fixture at `dbf4f33` measured 84 ms for load, 235 ms for the service summary, 286,099 decoded JavaScript bytes
and 17 ms for the p95 scrolling interval. All four medians passed the limits above.

### Accessibility evidence

Production-browser journeys cover keyboard navigation, review and edit focus, drawer dismissal on Escape and
resize, browser history, mixed selection and a keyboard-operated graph inspector across Chromium, Firefox and
WebKit. A separate Chromium sweep exercised 23 synthetic routes and states at 320 CSS pixels. The graph was
also checked with a focused inspector. At 320 px its search and inspector fit on screen and Tab, arrows,
Enter and Escape operate the graph without a pointer.

On fine pointing devices, the cursor glow fades smoothly into the backdrop at every edge, including
while moving diagonally. Touch, reduced motion and forced colors use the static backdrop.

Orca 46.1 in headed Chromium announced the skip link, Overview heading and chat search field. The session used
a private display, accessibility bus and fixture service. The check inspected Orca's generated speech text.
Audible pronunciation and physical assistive devices were outside this run.

The acceptance build with configuration readback and workspace recovery measured 88 ms for load, 243 ms
for the service summary, 287,444 decoded JavaScript bytes and 17 ms for the p95 scrolling interval
with the same seven-run fixture. All four medians met the budgets.

The Directory's Assign Persona action applies the selected pack to the selected chats only. Each write carries the
chat's displayed settings revision. Successful rows leave the selection, while conflicts keep their rows selected
for review. The selection island opens a review of the selected chat names, with status changes behind confirmation.
The directory reloads its settings and effective persona names after the batch.

With the Website layout and animated sidebar, the seven-run Overview fixture measured medians of 111 ms for load,
295 ms for the service summary, 432,409 decoded JavaScript bytes and 17 ms for the p95 scrolling interval.
All four met the budgets above.

At the routines list, the detail pane initially shows the first visible routine. A bookmarked routine takes
precedence, including its missing-item recovery state. Filtering updates the default detail without writing a job.
On phones, the navigation drawer also provides the Directory's Chat Defaults link.

Per-chat Access groups the reply switch, owner label and sender settings. The header shows the current reply state.
Send Message opens the composer in a tab. The Character and Reply tabs link to the assigned persona’s tool footer.

Dashboard service restart and stop open a confirmation dialog for the selected unit. Cancel or Escape returns to
the service control. Only the confirmation submits the operation.

The owner dashboard keeps its sidebar and workspace within the viewport. The workspace owns vertical scrolling,
including reader controls, route focus and list-position restoration. Data requests expose named loading states.
Overview visualizes reported service readiness, chat states, upcoming scheduled runs and library composition.
The catalogue uses bundled Figma cover illustrations as decorative placeholders and fits five cards on desktop.

On the full-height owner workspace the same seven-run fixture had median navigation load of 125 ms,
service summary of 359 ms, first-route JavaScript of 438,212 decoded bytes and a p95 frame interval of 17 ms.
Each met the legacy limits. The chat directory restores the exact originating link on history and breadcrumb
return. On narrow screens routine and library detail links bring the selected panel into view.

## Owner workspace refinements

Shell glass diffuses the selected finish behind navigation and content. Solid reading surfaces,
reduced transparency, and forced colors provide an opaque alternative. Dashboard controls use
the shared switch, buttons, choice marks, and menus while retaining accessible names and keyboard input.

The Chats strip has one selectable bar per chat. Its tooltip shows the owner-facing label, type, reply state
and last inbound date. The activity calendar counts retained inbound messages by UTC day across thirteen weeks.
The calendar places UTC weekdays down each column and successive weeks from left to right.
Dates and intensity labels align with the plot. Hover, keyboard focus, or tap on a day shows its
UTC date and inbound count, including zero. Future dates have no cell. Chart tooltips use an
opaque, contrasting surface and stay inside the viewport. Only dates and aggregate counts leave the protected activity endpoint.

The legacy catalogue omits the built-in `example` template, which remains available for persona creation.
Standalone includes the read-only Example pack so a first-run owner can inspect it before configuring models or chats.
Create opens a choice of agent instructions, manual entry or JSON import. Catalogue pages hold three rows at
the current column count. Persona editor tabs show one section and retain unsaved fields across tab changes.
The simulator uses the harness conversation layout and runs synthetic mood matching entirely in the browser.
Copy Prompt copies the full instructions and JSON template. Agent links open a new tab on explicit
activation. Copy confirmation and clipboard failures appear above the modal backdrop.
JSON import uses the document ID, card ID or filename in that order. Invalid input keeps the current draft.
Empty opener, ending and face lists are valid, as in the core mood schema and the shipped example.
A direct visit opens a saved persona with a selector. An editor-launched preview uses the unsaved draft.

The selected chat's Send Message tab holds text and attachment workflows. The host file recipient must match
the core's canonical gateway target or a unique, explicitly mapped phone number for a phone-addressed DM.
Old send bookmarks remain usable. Owners can select recent senders from that chat or add multiple sender IDs,
then review the change before saving.

The owner's protected core routes expose GET and PUT for chats/:id/profile-image and characters/:id/profile-image.
Images are dashboard portraits stored in the data volume separately from packs and WhatsApp. Reads return a nullable
base64 WebP. Writes normalize a static PNG, JPEG or WebP up to 4 MiB into a square WebP for an existing
target. Directory records indicate when a portrait exists. Missing portraits use chat glyphs or catalogue motifs.

System Profile Files browses the loaded core packs and their card, moods and lines documents. The protected Studio
GET with `?view=documents` can show these validated files read-only when a loaded data pack has unsupported assets.
It reads only the three named YAML files under the pack root. The normal Studio writer still checks the full tree.
Edits use Studio's
revision-checked writer. Device appearance uses actual finish samples and shares the System header. Toasts appear
at bottom center with a frosted surface. Clearing an override is labelled Use Defaults.
