# Test Harness

How AIRA is run, simulated, replayed and measured without WhatsApp and without live users, and which checks gate a
change.

## Principle

The core's only inbound interface is the gateway endpoint. The harness is a fake gateway: it posts the same requests
the real gateway would and reads the same responses. Everything behind the endpoint runs as it does in production.

## Test Layers

| Layer     | Runs                                                                      | Model Calls         | Where            |
| --------- | ------------------------------------------------------------------------- | ------------------- | ---------------- |
| Unit      | Pure functions: renderer, cleaning steps, resolver, parsers               | None                | Every commit, CI |
| Contract  | The gateway endpoint, the site API, tool schemas, config and pack schemas | None                | Every commit, CI |
| Replay    | Scripted conversations against recorded model replies                     | Replayed, zero live | Every commit, CI |
| Simulator | The memory simulator with ground truth                                    | Replayed, zero live | Every commit, CI |
| Benchmark | Latency and cost on fixed prompts                                         | Live                | On demand        |
| Live      | Tool triggering and persona checks against real models                    | Live                | Before a release |

A replay or simulator run that makes a live call fails. The harness counts live calls and asserts zero.

## Recordings

- Every model request is hashed from its role, model, prompt blocks, window, tool list and parameters.
- In `record` mode the harness calls the real model and stores the response under that hash.
- In `replay` mode it returns the stored response. A missing hash fails the test with the diff against the nearest
  stored request, so an unintended prompt change is visible.
- Recordings are files in the repository. They contain only invented conversations. No real chat text is ever
  recorded.
- `bun run harness:refresh <scenario>` re-records one scenario on purpose.

## Conversation Scenarios

A scenario is a file that describes chats, members, a character and a timeline of messages with times.

```yaml
chat: { id: g1, type: group, character: example }
members: [alice, bob]
steps:
  - at: '09:00'
    from: alice
    text: "@aira what's the plan for tonight?"
    expect:
      mood: playful
      maxChars: 400
      tools: []
  - at: '09:01'
    from: bob
    text: '/remind 6pm dinner'
    expect:
      command: remind
      receipt: reminder.created
```

Expectations check facts code controls: the mood, the shape, the tools called, receipts, the outcome, format rules,
and timing budgets. They do not assert exact model wording.

## Memory Simulator

- A generated set of chats and members with scripted facts, corrections, retractions and upcoming changes, and a
  ground-truth file stating what should be remembered at each point.
- It drives the full write path and recall with replayed model and judge calls.

| Check       | Fails When                                                                   |
| ----------- | ---------------------------------------------------------------------------- |
| Isolation   | Any item or recalled text appears in a chat other than its own               |
| Lost Writes | An accepted operation is absent after concurrent jobs or a simulated crash   |
| Drift       | Recall precision or recall against ground truth falls below the stored floor |
| Forget      | A forgotten fact is recalled, or forgetting one fact changes another         |
| Recovery    | Jobs in flight at a crash are not completed or retried after restart         |

## Fixed Gates

| Gate            | Threshold                                                   | Layer     |
| --------------- | ----------------------------------------------------------- | --------- |
| Prompt Size     | Every pack under `prompt.maxSystemTokens`                   | Contract  |
| Prompt Golden   | Assembled prompt for a fixed turn matches the stored copy   | Contract  |
| Format          | No unsupported markup after the renderer, on a fixed corpus | Unit      |
| Persona Purity  | No character name or phrase in `src/`                       | Unit      |
| Privacy Scan    | No phone number, WhatsApp id or real name in the tree       | Unit      |
| Memory          | All simulator checks pass                                   | Simulator |
| Zero Live Calls | Replay and simulator make no live call                      | Replay    |

A gate's stored value changes only in a pull request that says why.

## Benchmarks

`bun run bench` runs fixed prompt sets through the full turn against live models and writes one result file per run.

| Set       | Measures                                                     |
| --------- | ------------------------------------------------------------ |
| Casual    | Median and 90th percentile reply time with no tool call      |
| Tool      | The same for turns that call search and page reading         |
| Transport | Both transports on identical prompts, for the launch default |
| Cost      | Tokens and cost per turn, and cache hit rate                 |

Results are compared with the targets in the PRD (NFR-1). A benchmark does not gate a commit; it gates a release.

## Manual Tools

- `bun run chat --chat <id>` opens a terminal conversation through the fake gateway, with the turn record printed
  after each reply.
- `bun run turn <turn_id>` and `bun run report` are described in [Records](records.md).
- `bun run pack:check <id>` validates one character pack and prints its prompt size.

## Shadow Mode

Before cutover, the harness's request format is fed from production: real gateway requests are copied to the new
core, which runs the full turn and records it but returns nothing to WhatsApp. See [Deployment](deployment.md).
