# Models

Two transports behind one interface, the roles a model can play, routing, fallback and spend.

## Roles

| Role       | Used For                                         | Default Source  |
| ---------- | ------------------------------------------------ | --------------- |
| `main`     | The reply loop, memory extraction                | `llm.main`      |
| `fallback` | The reply loop when `main` fails                 | `llm.fallback`  |
| `judge`    | Mood override, memory admission and verification | `judge` section |
| `media`    | Watching pictures, audio and video at intake     | `media.watcher` |

Each role has its own key in `.env`. A role with no key is switched off, and features that need it say so in
character.

## Transport Setting

```yaml
llm:
  transport: api # api | subscription
  main: { provider: anthropic, model: <model id>, baseUrl: <url> }
  fallback: { provider: openai-compatible, model: <model id>, baseUrl: <url> }
  turnDeadlineMs: 45000
  monthlyBudgetUsd: 50
```

- `api` calls an OpenAI-compatible or native endpoint with a key.
- `subscription` runs the `claude` program on the owner's login through the host runner service.
- The launch default is the faster transport in the benchmark (**Spike S-4**). Until then it is `api`.

## Turn Runner Interface

Both transports implement one interface.

```ts
interface TurnRunner {
  run(input: {
    system: PromptBlocks
    window: Message[]
    tools: OfferedTool[]
    context: TurnContext
    deadline: number
  }): Promise<{ text: string; toolCalls: ToolCallRecord[]; usage: Usage; model: string }>
}
```

| Aspect         | API Runner                          | Subscription Runner                                                   |
| -------------- | ----------------------------------- | --------------------------------------------------------------------- |
| Loop Owner     | The agent kit, inside the core      | The `claude` program, on the host                                     |
| Tools          | Registry handlers called in process | The same registry, served by the core over the Model Context Protocol |
| Built-in Tools | None                                | All disabled                                                          |
| Prompt         | Blocks sent as the system prompt    | The same blocks, passed as the system prompt                          |
| Usage And Cost | From the provider response          | From the program's result line                                        |
| Start-up Cost  | None                                | One process start per turn                                            |
| Limits         | Provider rate limits, the spend cap | The subscription's rolling limits                                     |

Everything outside the runner is shared: prompt assembly, the offered tool list, the cleaning chain, records.

## Host Runner Service

The `claude` program needs the owner's login, which lives in his home folder on the host. A container cannot hold
it safely. When `transport: subscription` is set:

- A small host service listens on a loopback port and accepts a run request from the core.
- It starts the program with no built-in tools, no settings files, the system prompt, and the core's tool server
  address.
- It streams the result back. It holds no state and reads no AIRA data.
- If the service is down, the core treats the transport as unavailable and uses the fallback role.

## Failure Kinds

| Kind         | Examples                        | Action                                   |
| ------------ | ------------------------------- | ---------------------------------------- |
| `transient`  | Timeout, 5xx, connection reset  | Retry with backoff inside the deadline   |
| `rate_limit` | 429, subscription limit reached | Switch to fallback, open the breaker     |
| `auth`       | 401, 403, expired login         | Switch to fallback, alert the operator   |
| `refusal`    | The model declines              | Send the pack's refusal line             |
| `malformed`  | Empty or unparseable reply      | One retry, then the pack's fallback line |
| `budget`     | Monthly cap reached             | Send the pack's limit line               |

## Fallback

- The fallback model answers on the same runner interface with the same prompt and tools.
- A breaker per role opens after a `rate_limit` or `auth` failure and stays open for `llm.breakerMs`. While open,
  turns go straight to the fallback. The breaker state is process-wide for a role, not per chat or character,
  because the limit it guards is account-wide.
- Each fallback is written to the turn record with the failure kind that caused it.
- If both roles fail, the turn ends with the pack's error line and a failure record.

## Media Watching

Media is read at intake, before the main model runs.

1. Code checks type, size and duration against `media` limits.
2. The media model returns a description, and a transcript where there is speech.
3. The description enters prompt block 4 as labelled, untrusted text. The main model never receives the file.
4. A file over a limit, or a failed read, produces the pack's unreadable-media line and a record.

Video from a linked social post is fetched by the social tool and passed through the same path.

## Spend

Real token counts and prices are recorded per call. At 80% of `llm.monthlyBudgetUsd`, background work (memory
extraction, the mood judge) stops. At 100%, replies stop with the pack's limit line. The subscription transport
records estimated cost for comparison and does not count against the cap.

## Configuration

| Key                     | Default | Effect                               |
| ----------------------- | ------- | ------------------------------------ |
| `llm.transport`         | `api`   | Selects the runner                   |
| `llm.turnDeadlineMs`    | 45000   | Hard limit for one turn's model work |
| `llm.maxRetries`        | 2       | Retries for a `transient` failure    |
| `llm.breakerMs`         | 600000  | How long a breaker stays open        |
| `llm.monthlyBudgetUsd`  | 50      | Spend cap for paid roles             |
| `media.watcher.model`   | unset   | The media model                      |
| `media.maxVideoSeconds` | 180     | Longest video that is watched        |
