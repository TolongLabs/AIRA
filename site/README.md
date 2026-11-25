# Owner Site

The private AIRA dashboard uses the same owner API from both the canonical routes and the preview.
Open `/app/preview/overview` on a staged install. With the dashboard entry enabled, `/` opens `/overview`.
Selecting the classic entry restores the original site under `/app/`. See the [route map](../docs/trd/dashboard-routes.md),
[state ownership matrix](../docs/trd/dashboard-state.md) and [design contract](../docs/DESIGN.md).

For a new standalone installation, follow the [installation guide](../docs/INSTALL.md). The bundled site renders
the keyless setup tasks and typed settings using the standalone owner credential. Legacy hosts keep their existing
owner-service authorization. A standalone service does not expose unavailable legacy-only capabilities.

Build the site from the repository root.

```sh
cd site
bun install
bun run build
```

## Dashboard assets

The dashboard uses local Outfit, Unbounded and Geist Mono files. The corresponding SIL Open Font Licenses are in
[the font directory](public/dashboard/fonts/). The robot glyph follows the approved AIRA design.

The lattice and stipple are original repeating ASCII tiles. The TolongDesign catalogue provided the
[ASCII pattern reference](https://ascii.rest/). The shell and selection behavior follow the
[ObsidianUI dashboard shell](https://www.obsidianui.dev/docs/dashboard-shell) reference. Field and tab
composition follows [shadcn/studio](https://shadcnstudio.com/). These references supplied interaction patterns.
