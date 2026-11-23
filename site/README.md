# Owner Site

Mirai, the owner site, specified in [`docs/trd/site.md`](../docs/trd/site.md). Its design contract is
[the AIRA web design contract](../docs/DESIGN.md), which wins for anything visual.

This is the existing site as it was imported, scrubbed of private data. The revamp (FR-40 to FR-42) changes it from
here. The `site` job in CI typechecks and builds it.

```sh
cd site
bun install
bun run build
```

## Dashboard assets

The preview uses local Outfit, Unbounded and Geist Mono files. The corresponding SIL Open Font Licenses are in
[the font directory](public/dashboard/fonts/). The robot glyph follows the approved AIRA design.

The lattice and stipple are original repeating ASCII tiles. The TolongDesign catalogue provided the
[ASCII pattern reference](https://ascii.rest/). The shell and selection behavior follow the
[ObsidianUI dashboard shell](https://www.obsidianui.dev/docs/dashboard-shell) reference. Field and tab
composition follows [shadcn/studio](https://shadcnstudio.com/). These references supplied interaction patterns.
