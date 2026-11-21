# Graphify

This project has a knowledge graph at `graphify-out/` with god nodes, community
structure, and cross-file relationships.

Rules:

- For codebase questions, first run `graphify query "<question>"` when
  `graphify-out/graph.json` exists. Use `graphify path "<A>" "<B>"` for
  relationships and `graphify explain "<concept>"` for focused concepts. These
  return a scoped subgraph, usually much smaller than `GRAPH_REPORT.md` or raw
  grep output.
- If `graphify-out/wiki/index.md` exists, use it for broad navigation instead of
  raw source browsing.
- Read `graphify-out/GRAPH_REPORT.md` only for broad architecture review or when
  query/path/explain do not surface enough context.
- For a local refresh, run `graphify update .` with `graphifyy[sql]==0.9.71`.
  The AST pass uses no model calls. It merges into the tracked
  `graphify-out/graph.json` and preserves its curated semantic nodes. Keep that
  file in place. Use the Graphify skill to refresh semantic nodes when needed.
- The `graph` workflow refreshes the committed graph after changes land on
  `main`. It publishes graph changes on `automation/graph` through the release
  GitHub App. The pull request contains only `graphify-out/graph.json` and
  follows the required checks and rebase rules for `main`. The workflow
  merges the App’s graph-only pull request after the required checks pass for
  its current head commit.
- Graph-only pushes skip the refresh. A successful refresh with no changes
  beyond the source commit stamp skips the pull request. To retry a refresh,
  run the `graph` workflow on `main`.
