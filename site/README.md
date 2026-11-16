# Owner Site

Mirai, the owner site, specified in [`docs/trd/site.md`](../docs/trd/site.md). Its design contract is
[`DESIGN.md`](DESIGN.md), which wins for anything visual.

This is the existing site as it was imported, scrubbed of private data. The revamp (FR-40 to FR-42) changes it from
here. The `site` job in CI typechecks and builds it.

```sh
cd site
bun install
bun run build
```
