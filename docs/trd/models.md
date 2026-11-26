# Models

Two transports behind one interface, the roles a model can play, routing, fallback and spend.

## Roles

| Role       | Used For                                         | Default Source  |
| ---------- | ------------------------------------------------ | --------------- |
| `main`     | The reply loop, memory extraction                | `llm.main`      |
| `fallback` | The reply loop when `main` fails                 | `llm.fallback`  |
| `judge`    | Mood override, memory admission and verification | `judge` section |
| `media`    | Watching pictures, audio and video at intake     | `media.watcher` |

Legacy roles have their own keys in `.env`; standalone credentials are private applied revisions. A role with no
key is switched off, and features that need it say so in character.

## Standalone Model Readiness

In standalone mode the main model is optional at boot, but required before the chatbot can accept turns.
A new install without an applied model revision starts with configuration `setup_required` and chatbot
`inactive` (reason `model_setup_required`). A missing key or model is not a storage or deployment failure.
The core must not dispatch a placeholder model or make a paid probe. Legacy API and subscription startup
validation are unchanged. Standalone supports only the API main and optional API fallback transport;
host-router and subscription transport are not standalone capabilities. An explicit optional Gemini media watcher
may be saved and applied separately from main/fallback, with its own private key and model ID. Its applied
configuration status is not evidence of inbound media transport. Keyless main, a missing/cleared media key,
or a historical revision without the optional role leaves the watcher off; legacy variables are not authority.

A standalone main client exists only when an explicitly configured,
validated model target and credential are available. The no-client branch must not invoke the turn runner,
memory extraction, research model or another model path. The saved/applied revision, credential authority and controlled activation are defined in
[Dashboard state](dashboard-state.md#model-revision-authority).

## Transport Setting

```yaml
llm:
  transport: api # api | subscription
  main: { provider: anthropic, model: claude-haiku-5-5, effort: medium, baseUrl: 'https://api.anthropic.com' }
  fallback:
    provider: openai-compatible
    model: deepseek-ai/DeepSeek-V4.1-Flash-1017
    effort: high
    baseUrl: 'https://api-inference.modelscope.ai/v1'
  turnDeadlineMs: 45000
  monthlyBudgetUsd: 50
```

- `api` calls the role's endpoint with its key: `LLM_API_KEY` for `main`, `LLM_FALLBACK_API_KEY` for `fallback`.
- `subscription` runs the `claude` program on the owner's login through the host runner service.
- Both transports run the main role on the same `llm.main.model` at the same `llm.main.effort`. Only the way the
  model is reached differs.
- The launch default is `api`, the faster transport in the benchmark (S-4, measured on dev2, 17 Nov 2026, same image,
  same model `claude-haiku-5-5` at `medium`, one chat per set; latency from arrival to return, including the 1.5 s
  batch wait):

  | Set              | API p50 / p90 | Subscription p50 / p90 |
  | ---------------- | ------------- | ---------------------- |
  | Casual, 12 turns | 3.2 s / 3.4 s | 5.5 s / 5.9 s          |
  | Tool, 8 turns    | 6.9 s / 9.0 s | 5.8 s / 8.9 s          |

  Both delivered every turn. The subscription runner adds about 2.3 s to a casual turn, the program's start-up, and
  ties on tool turns. The subscription runner stays available as `llm.transport: subscription` with the host runner
  in `deploy/host-runner/`, which is not installed on dev2.

- The launch models above hold. Claude Sonnet 5.5 is the candidate for a later main model.

## Providers And Effort

A role's `provider` decides the request shape. Both providers serve both roles.

| Provider            | Endpoint                            | Effort Sent As                                          | Prompt Caching                      |
| ------------------- | ----------------------------------- | ------------------------------------------------------- | ----------------------------------- |
| `anthropic`         | Claude's native `POST /v1/messages` | `thinking: {type: adaptive}` and `output_config.effort` | The stable prompt blocks and tools  |
| `openai-compatible` | `POST <baseUrl>/chat/completions`   | `reasoning_effort`                                      | Whatever the server does on its own |

- `effort` is optional. Empty sends nothing, and the model's own default applies. The accepted values belong to
  the model: Claude takes `low`, `medium`, `high`, `xhigh` and `max`. DeepSeek V4.1 Flash takes `none` (thinking
  off), `low`, `high` and `max`, and maps the other names onto those. Start-up refuses an `anthropic` effort
  outside Claude's list. An OpenAI-compatible server checks its own: ModelScope answers an unknown value with 400.
- Claude is never reached through its OpenAI-compatible layer. Measured on 16 Nov 2026: that layer accepts any
  effort, including an invalid one, and ignores it, and it has no prompt caching. The native endpoint rejects an
  invalid effort, and the same question took 147 output tokens at `low` and 482 at `max`.
- The `anthropic` provider sends no sampling parameter. Claude 5 models refuse a non-default `temperature`. A
  response schema is sent as `output_config.format`. Without `max_tokens` in the request, the client sends 16,000.
- The subscription runner passes `llm.main.effort` to the program as `--effort`, and `medium` when it is empty,
  which is Claude Haiku 5.5's own default.

### Deeper Thinking

A member asks for one deeper turn by starting the message with `/think` (PRD FR-45).

- **Prefix.** `/think` as the first word of the newest message, in any case, followed by a space or the end of the
  message. Code removes it before the text is stored or reaches the model. Anywhere else in a message it is ordinary
  text. It is not a tool command and is not listed by `/help` as one; `/help` names it in one line.
- **Effort.** That turn runs the main role at `llm.main.deepEffort` (default `high`) and the fallback at
  `llm.fallback.deepEffort` (default `max`), each checked against its provider's list as `effort` is. Empty means
  the role's normal `effort`. The subscription runner passes `deepEffort` as `--effort`. Memory, the judge and media
  keep their own settings.
- **Switch.** `features.think` (default on) turns the prefix on per chat. Off: the prefix is removed and the turn runs
  at normal effort, so the member's text still reads naturally.
- **Record.** The turn record stores the effort each model call used and `think: true` when the prefix raised it.
- Raising effort without the prefix, from reply-shape signals, is not built (FR-45 optional part).

### Turn State Of A Provider

A thinking model returns state that must come back with the next request of the same loop: Claude's thinking
blocks, and an OpenAI-compatible server's `reasoning_content`. Claude refuses tool results without the thinking
that asked for them, and DeepSeek's own API does the same without `reasoning_content`.

- The client returns that state with the response. The API runner keeps it for the turn, keyed by the tool calls it
  came with, and the client sends it back with that assistant step.
- It never outlives the turn and is never stored. The window holds text only, so a later turn starts without it.
- The fallback can take over mid-loop, so the state carries its provider. A client sends back only state of its
  own provider and drops the rest.

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

The dashboard offers the Claude Code route for the primary or fallback role when its readiness check succeeds.
The host also reports `aira-router.service` separately. Its local OpenAI-compatible `aira` model is eligible for either API role after the middleware verifies the service owns the loopback listener. It rechecks availability when changing routes. Existing installations retain their configured primary and fallback.
A pinned regeneration stays on its original role. Switching transports after an API failure cannot repeat tools
already called in that turn.

## Host Runner Service

The `claude` program needs the owner's login, which lives in his home folder on the host. A container cannot hold
it safely. When `transport: subscription` is set:

- A small host service listens on a loopback port and accepts a run request from the core.
- It starts the program with no built-in tools, no settings files, the system prompt, and the core's tool server
  address.
- It streams the result back. It holds no state and reads no AIRA data.
- If the service is down, the core treats the transport as unavailable and uses the fallback role. Once any tool
  starts in a subscription run, a later failure ends the run. Starting the fallback from the original prompt could
  repeat that action.
- On this transport the fallback model answers on the API runner, with a breaker of its own. Memory extraction
  uses `llm.main` when it has a key, else `llm.fallback`. With neither, nothing is extracted.
- One run is one program start. There is no retry inside the subscription runner.

### Run Request

The core sends one request per model run to `POST <runnerUrl>/run`, with the shared secret `RUNNER_TOKEN` as a
bearer token. The service answers with the program's output lines as they arrive, one JSON object per line.
A turn can start one additional run when the [role check](prompt-engine.md#staying-in-role) flags a reply.
The additional run uses the same model and an empty tool session.

| Field       | Meaning                                                                        |
| ----------- | ------------------------------------------------------------------------------ |
| `system`    | The prompt blocks joined in order, passed as the program's whole system prompt |
| `prompt`    | The conversation, as text. See below                                           |
| `model`     | `llm.main.model`                                                               |
| `effort`    | `llm.main.effort`, or `medium` when it is empty                                |
| `tools`     | The address of the core's tool server for this turn, and this turn's token     |
| `timeoutMs` | The time left before the turn deadline. The service stops the program after it |

- The program starts with: print mode, stream output, no built-in tools, no settings sources, no saved session, no
  slash commands, and only the tool server named in the request. The prompt is written to its standard input.
- The program takes one prompt, not a list of messages. The core writes the earlier messages of the window as a
  labelled transcript and the messages this turn answers after it (A-7, confirmed by the S-4 benchmark, 17 Nov 2026).
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
- Tool calls arrive as JSON bodies of at most 1 MiB. A larger declared or streamed body is refused with 413.
- The program shows a tool to the model under a prefixed name. The prompt's tool list is written with the same
  prefix on this transport (A-7, confirmed by the S-4 benchmark, 17 Nov 2026).

## Failure Kinds

| Kind         | Examples                        | Action                                              |
| ------------ | ------------------------------- | --------------------------------------------------- |
| `transient`  | Timeout, 5xx, connection reset  | Retry with backoff inside the deadline              |
| `rate_limit` | 429, subscription limit reached | Switch to fallback, open the breaker                |
| `auth`       | 401, 403, expired login         | Switch to fallback, alert the operator              |
| `refusal`    | The model declines              | Send the pack's refusal line                        |
| `malformed`  | Empty or unparseable reply      | Retry and switch route, then bounded reply recovery |
| `budget`     | Monthly cap reached             | Send the pack's limit line                          |

## Fallback

After routing, an API reply step that still returns a malformed response or no usable text or offered tool call
can recover for up to 12 seconds within the original turn deadline. Wait 250 ms before the first recovery call
and double the delay to a maximum of 4 seconds. The recovery asks for a final answer from the original conversation
and completed tool results, with tools withdrawn. Required command tools that have yet to run keep their gate.
Cancellation, refusal, authentication, spend limits and open provider breakers still apply. Each actual model
attempt uses the normal route and accounting. Completed tools and their receipts stay in the original turn.

- The fallback model answers on the same runner interface with the same prompt and tools.
- For an API reply, retry only the failed model request, keeping any completed tool results. Transient failures
  wait 250 ms, then double the wait up to 4 s. When a fallback is available, switch after `llm.maxRetries` retries
  on the main model. On the last available or pinned model, keep retrying while the next wait fits inside the
  original turn deadline. Cancellation and the spend cap stop further calls. Setting `llm.maxRetries` to 0
  disables these waits and retries on every role.
- A breaker per role opens after a `rate_limit` or `auth` failure and stays open for `llm.breakerMs`. While open,
  turns go straight to the fallback. The breaker state is process-wide for a role, not per chat or character,
  because the limit it guards is account-wide.
- Each fallback is written to the turn record with the failure kind that caused it.
- If both roles fail, the turn ends with the pack's error line and a failure record.

![Sequence of a model call: runner choice, retries, fallback, spend cap, and recorded attempts](../diagrams/model-routing.svg)

## Media Watching

See [Media Pipelines](media-pipelines.md#media-watching).

### How Media Reaches The Core

See [Media Pipelines](media-pipelines.md#how-media-reaches-the-core).

### Quoted Media

See [Media Pipelines](media-pipelines.md#quoted-media).

### YouTube Links

See [Media Pipelines](media-pipelines.md#youtube-links).

### Post Links

See [Media Pipelines](media-pipelines.md#post-links).

### Limits

See [Media Pipelines](media-pipelines.md#media-limits).

### Records

See [Media Pipelines](media-pipelines.md#media-records).

### Failures

See [Media Pipelines](media-pipelines.md#media-failures).

## Social Post And Reply Readers

See [Media Pipelines](media-pipelines.md#social-post-and-reply-readers).

## Spend

Real token counts and prices are recorded per call, in the `spend` table by month and role. The cost of a call is
the cost the provider's response reports. When it reports none, the cost is the token counts times the role's
prices in `config.yml`. A role with no reported cost and prices of 0 costs nothing on record, so set its prices
before relying on the cap. At 80% of `llm.monthlyBudgetUsd`, background work (memory
extraction, the mood judge) stops. At 100%, replies stop with the pack's limit line. A monthly budget of 0 or less
switches both gates off: background work and replies run with no spend check. The subscription transport
records estimated cost for comparison and does not count against the cap.

Claude's API reports no cost, so `main` carries Claude Haiku 5.5's prices: 0.10 in, 0.50 out and 0.01 for a cache
read, per million tokens, for prompts up to 100,000 tokens. The ModelScope fallback is paid in its own daily
credit, about one per call, not in dollars, so its prices are 0 and it does not count against the cap.

## Configuration

| Key                                                            | Default                 | Effect                                                             |
| -------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------ |
| `llm.transport`                                                | `api`                   | Selects the runner                                                 |
| `llm.turnDeadlineMs`                                           | 45000                   | Hard limit for one turn's model work                               |
| `llm.maxRetries`                                               | 2                       | Main retries before fallback. Zero disables transient retries      |
| `llm.breakerMs`                                                | 600000                  | How long a breaker stays open                                      |
| `llm.monthlyBudgetUsd`                                         | 50                      | Spend cap for paid roles                                           |
| `llm.subscription.runnerUrl`                                   | `http://127.0.0.1:9882` | The host runner service                                            |
| `llm.subscription.toolServerPort`, `toolServerUrl`             | 9883                    | The core's tool server for the program                             |
| `llm.<role>.provider`                                          | see above               | `anthropic` or `openai-compatible`, for `main` and `fallback`      |
| `llm.<role>.model`, `baseUrl`                                  | see above               | The model id and its endpoint                                      |
| `llm.<role>.effort`                                            | `medium`, `high`        | Effort for `main` and `fallback`. Empty: the model's default       |
| `llm.<role>.usdPerMTokIn`, `usdPerMTokOut`, `usdPerMTokCached` | see `config.yml`        | Prices for `main` and `fallback`, in US dollars per million tokens |

Media settings are in [Media Pipelines](media-pipelines.md#configuration).
