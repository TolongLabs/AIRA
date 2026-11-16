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
- On this transport the fallback model answers on the API runner, with a breaker of its own. Memory extraction
  uses `llm.main` when it has a key, else `llm.fallback`. With neither, nothing is extracted.
- One run is one program start. There is no retry inside the subscription runner.

### Run Request

The core sends one request per turn to `POST <runnerUrl>/run`, with the shared secret `RUNNER_TOKEN` as a bearer
token. The service answers with the program's output lines as they arrive, one JSON object per line.

| Field       | Meaning                                                                        |
| ----------- | ------------------------------------------------------------------------------ |
| `system`    | The prompt blocks joined in order, passed as the program's whole system prompt |
| `prompt`    | The conversation, as text. See below                                           |
| `model`     | `llm.subscription.model`, or absent for the program's default                  |
| `tools`     | The address of the core's tool server for this turn, and this turn's token     |
| `timeoutMs` | The time left before the turn deadline. The service stops the program after it |

- The program starts with: print mode, stream output, no built-in tools, no settings sources, no saved session, no
  slash commands, and only the tool server named in the request. The prompt is written to its standard input.
- The program takes one prompt, not a list of messages. The core writes the earlier messages of the window as a
  labelled transcript and the messages this turn answers after it (**Assumption A-7**, the tool names confirmed).
- The last output line of type `result` holds the reply text, the token counts and the estimated cost.
- A failed run is a `result` line with `is_error` true, even when its `subtype` says `success`. Its kind comes from
  `api_error_status` (429 or 529 is a rate limit, 401 or 403 is auth), then from the program's own `error` on the
  assistant line, then from the text: "You've hit your session limit" is a rate limit. The program then exits with
  an error, so the service's exit line is the cause only when no failed result came. Measured on the host with a
  spent subscription, 16 Nov 2026.
- The system prompt holds recalled memory, and the tool server address comes with this turn's token. The service
  passes both in private temporary files, removed when the program ends, so neither shows in the host's process
  list. The program never receives the service's own secret.
- The service keeps no state and reads no AIRA data. A second request while one runs is accepted:
  each request is its own program.

### Tool Server For The Program

- The core listens on `llm.subscription.toolServerPort`, on loopback, only while the transport is `subscription`.
- Each turn gets a random token. A request with a token of no running turn is refused. The token dies when the
  turn's run ends.
- The server lists exactly the tools offered to that turn, and calls them through the registry, so permissions,
  timeouts, receipts and records are the same as on the API runner.
- The two chain limits of [Tools](tools.md#implicit-calls) are enforced here: past a limit every call is refused.
- For a skill-style command, the named tool is the only one listed until it has been called.
- The program shows a tool to the model under a prefixed name. The prompt's tool list is written with the same
  prefix on this transport (**Assumption A-7**, the tool names confirmed).

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

Real token counts and prices are recorded per call, in the `spend` table by month and role. The cost of a call is
the cost the provider's response reports. When it reports none, the cost is the token counts times the role's
prices in `config.yml`. A role with no reported cost and prices of 0 costs nothing on record, so set its prices
before relying on the cap. At 80% of `llm.monthlyBudgetUsd`, background work (memory
extraction, the mood judge) stops. At 100%, replies stop with the pack's limit line. The subscription transport
records estimated cost for comparison and does not count against the cap.

## Configuration

| Key                                                            | Default                 | Effect                                                             |
| -------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------ |
| `llm.transport`                                                | `api`                   | Selects the runner                                                 |
| `llm.turnDeadlineMs`                                           | 45000                   | Hard limit for one turn's model work                               |
| `llm.maxRetries`                                               | 2                       | Retries for a `transient` failure                                  |
| `llm.breakerMs`                                                | 600000                  | How long a breaker stays open                                      |
| `llm.monthlyBudgetUsd`                                         | 50                      | Spend cap for paid roles                                           |
| `llm.subscription.runnerUrl`                                   | `http://127.0.0.1:9882` | The host runner service                                            |
| `llm.subscription.model`                                       | empty                   | Model alias for the program                                        |
| `llm.subscription.toolServerPort`, `toolServerUrl`             | 9883                    | The core's tool server for the program                             |
| `llm.<role>.usdPerMTokIn`, `usdPerMTokOut`, `usdPerMTokCached` | 0                       | Prices for `main` and `fallback`, in US dollars per million tokens |
| `media.watcher.model`                                          | unset                   | The media model                                                    |
| `media.maxVideoSeconds`                                        | 180                     | Longest video that is watched                                      |
