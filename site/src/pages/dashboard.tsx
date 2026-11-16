import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
} from "recharts";
import {
  BookOpen,
  Clock,
  LineChart,
  Music,
  Network,
  Play,
  RotateCw,
  Settings2,
  Square,
  Type,
} from "lucide-react";
import type { Dashboard } from "@/lib/api";
import { post } from "@/lib/api";
import { useApi, toast, Toaster, useThemeColors } from "@/lib/hooks";
import { ago, num, until } from "@/lib/utils";
import { Shell } from "@/components/shell";
import type { HeroToken } from "@/components/shell";
import {
  Badge,
  Button,
  Card,
  CardHead,
  ConfirmAction,
  Empty,
  MetricCard,
  NextCard,
  Section,
  Spinner,
} from "@/components/ui";

/* Four questions this page answers, in order: what do I know, what is she
   holding for me, who is she talking to, and is anything on fire. Each gets
   its own titled band — the old version was one undifferentiated bento and
   read as soup. */

const BRAIN_TILES = [
  /* `note` is context, not ideas — an idea is filed as a project by
     mirror_idea, so the tile beside this one is the one that counts them. */
  {
    label: "notes",
    keys: ["note", "notes"],
    color: "var(--mem)",
    href: "/app/library.html#note",
  },
  {
    label: "projects",
    keys: ["project", "projects"],
    color: "var(--vocab)",
    href: "/app/library.html#project",
  },
  {
    label: "people",
    keys: ["person", "people"],
    color: "var(--artist)",
    href: "/app/library.html#person",
  },
  {
    label: "topics",
    keys: ["topic", "topics"],
    color: "var(--gram)",
    href: "/app/library.html#topic",
  },
] as const;

const TYPE_COLOR: Record<string, string> = {
  song: "var(--song)",
  vocab: "var(--vocab)",
  word: "var(--vocab)",
  grammar: "var(--gram)",
  artist: "var(--artist)",
  project: "var(--vocab)",
  person: "var(--artist)",
  topic: "var(--gram)",
};

function pick(
  brain: Record<string, number> | undefined,
  keys: readonly string[],
) {
  for (const k of keys) if (brain?.[k] != null) return brain[k];
  return 0;
}

function StatTiles({
  tiles,
  brain,
}: {
  tiles: readonly {
    label: string;
    keys: readonly string[];
    color: string;
    href?: string;
  }[];
  brain?: Record<string, number>;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 md:grid-cols-4 [&>*]:min-w-0">
      {tiles.map((t) => (
        // A count you cannot click is a dead end, and these are exactly the
        // types the library page lists — so the number goes where it leads.
        <a
          key={t.label}
          href={t.href}
          className="glass block rounded-card p-4 pt-3.5 text-ink no-underline
                     transition-opacity hover:opacity-80"
        >
          <div
            className="mb-2 h-1 w-9 rounded-full"
            style={{ background: t.color }}
          />
          <div
            className="tnum font-serif text-[2.4rem] leading-none tracking-[-0.02em]"
            style={{ color: t.color }}
          >
            {num(pick(brain, t.keys))}
          </div>
          <div className="mt-1.5 font-mono text-[0.68rem] font-medium uppercase tracking-[0.1em] text-muted">
            {t.label}
          </div>
        </a>
      ))}
    </div>
  );
}

function ServiceRow({
  unit,
  state,
  onDone,
}: {
  unit: string;
  state: string;
  onDone: () => void;
}) {
  const on = state === "active";
  const tone = on
    ? "var(--up)"
    : state === "failed"
      ? "var(--down)"
      : "var(--amber)";

  async function act(action: "start" | "stop" | "restart") {
    try {
      await post("/api/services", { unit, action });
      toast(`${unit} ${action} ✓`);
      window.setTimeout(onDone, 900);
    } catch (e) {
      toast((e as Error).message, false);
      // Rethrown so a confirm strip stays open on a failed stop.
      throw e;
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-line-2 py-2.5 first:border-t-0 first:pt-0">
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ background: tone }}
      />
      <span className="min-w-0 flex-1 truncate text-[0.95rem]">{unit}</span>
      <span className="text-[0.82rem] text-muted">{state}</span>
      <div className="flex gap-1">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void act("restart")}
          title="restart"
        >
          <RotateCw />
        </Button>
        {on ? (
          /* Was an ICON-ONLY button whose accessible name went "stop" ->
             "really stop?" on the same element. A screen-reader user hears
             nothing change, presses Enter again, and a live service stops. */
          <ConfirmAction
            label="stop"
            confirmLabel="Stop"
            icon={<Square />}
            question={`Stop ${unit}?`}
            warning="It stays down until you start it again."
            onConfirm={() => act("stop")}
          />
        ) : (
          <Button
            size="sm"
            variant="ghost"
            title="start"
            onClick={() => void act("start")}
          >
            <Play />
          </Button>
        )}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { data, error, loading, reload } = useApi<Dashboard>("/api/dashboard");
  const cron = useApi<{ jobs: import("@/lib/api").CronJob[] }>("/api/cron");

  const activity = useMemo(() => {
    const a = data?.activity ?? [];
    return a.map((n, i) => ({
      day: i === a.length - 1 ? "today" : `${a.length - 1 - i}d`,
      filed: n,
    }));
  }, [data]);

  const upcoming = useMemo(() => {
    return (cron.data?.jobs ?? [])
      .filter((j) => j.enabled && j.next_run_at)
      .map((j) => ({ ...j, ts: Date.parse(j.next_run_at!) / 1000 }))
      .filter((j) => !Number.isNaN(j.ts))
      .sort((a, b) => a.ts - b.ts)
      .slice(0, 5);
  }, [cron.data]);

  const filedTotal = (data?.activity ?? []).reduce((a, b) => a + b, 0);
  const c = useThemeColors({
    accent: "--accent",
    line: "--line",
    muted: "--muted",
    card2: "--card-2",
    lineStrong: "--line-strong",
    ink: "--ink",
  });

  const next = upcoming[0];
  /* The head. Every other page opens with a fact at display size and this one
     opened with the word "Dashboard" — a label for the page the reader is
     already on, in the most valuable band of the screen, under a wordmark that
     already said where they are.
     What this page knows and no other does is whether the thing is RUNNING, and
     that was buried at the very bottom in System. So it states service health
     first and goes red when anything is down; the counts stay in the cards
     below, where four numbers belong. It says nothing about any one chat, so it
     reads the same on one group or fifty. */
  const units = Object.entries(data?.services ?? {});
  const down = units.filter(([, s]) => s !== "active").map(([u]) => u);
  const chats = data?.chat_summaries?.length ?? 0;
  const hero: HeroToken[] = !data
    ? [{ t: "Checking on her…" }]
    : down.length
      ? [
          { n: down.length, tone: "down" },
          {
            t: down.length === 1 ? " service down: " : " services down: ",
            tone: "down",
          },
          { n: down.join(", "), tone: "down" },
        ]
      : [
          { n: units.length },
          { t: " services up, " },
          { n: chats },
          { t: chats === 1 ? " chat configured" : " chats configured" },
        ];
  /* The counts the metric row and the rail both read from. Kept as one object
     so the four cards and the "where to go next" details cannot disagree. */
  const lib = {
    songs: pick(data?.brain, ["song", "songs"]),
    words: pick(data?.brain, ["vocab", "word"]),
    patterns: pick(data?.brain, ["grammar"]),
    artists: pick(data?.brain, ["artist", "artists"]),
  };

  return (
    <Shell page="index" title="Dashboard" hero={hero}>
      <Toaster />

      {error && (
        <Card className="mb-6 border-down/40 p-4 text-down">
          Could not reach the brain: {error}
        </Card>
      )}
      {loading && !data && (
        <div className="flex items-center gap-2 text-muted">
          <Spinner /> loading…
        </div>
      )}

      {data && (
        <>
          {/* The first screen. Everything that answers "what is she holding for
              me, and where do I go" lands above the fold; the ledgers below
              are for when you have a reason to scroll. */}
          <section className="grid gap-5 lg:grid-cols-3">
            <div className="flex min-w-0 flex-col gap-5 lg:col-span-2">
              <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 sm:grid-cols-4 [&>*]:min-w-0">
                <MetricCard
                  label="words"
                  value={num(lib.words)}
                  icon={Type}
                  tint="var(--vocab)"
                  href="/app/library.html#vocab"
                  caption="glossed and cross-linked"
                />
                <MetricCard
                  label="songs"
                  value={num(lib.songs)}
                  icon={Music}
                  tint="var(--song)"
                  href="/app/library.html#song"
                  caption="worked through line by line"
                />
                <MetricCard
                  label="patterns"
                  value={num(lib.patterns)}
                  icon={BookOpen}
                  tint="var(--gram)"
                  href="/app/library.html#grammar"
                  caption="grammar patterns filed"
                />
                <MetricCard
                  label="filed"
                  value={num(filedTotal)}
                  icon={Network}
                  tint="var(--mem)"
                  href="/app/graph.html"
                  caption="in the last 14 days"
                />
              </div>

              <Card className="flex min-h-0 flex-1 flex-col p-5">
                <CardHead
                  title="Filed, last 14 days"
                  action={
                    <span className="text-[0.82rem] text-muted">
                      {filedTotal
                        ? `${num(filedTotal)} filed`
                        : "a quiet fortnight"}
                    </span>
                  }
                />
                <div className="mt-4 h-52 lg:h-full lg:min-h-52">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={activity}
                      margin={{ top: 4, right: 4, bottom: 0, left: 4 }}
                    >
                      <CartesianGrid vertical={false} stroke={c.line} />
                      <XAxis
                        dataKey="day"
                        tickLine={false}
                        axisLine={false}
                        interval="preserveStartEnd"
                        tick={{ fill: c.muted, fontSize: 11 }}
                      />
                      <Tooltip
                        cursor={{ fill: c.card2 }}
                        contentStyle={{
                          background: c.card2,
                          border: `1px solid ${c.lineStrong}`,
                          borderRadius: 10,
                          color: c.ink,
                        }}
                      />
                      <Bar
                        dataKey="filed"
                        fill={c.accent}
                        radius={[4, 4, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Card>
            </div>

            {/* Where to go next. A dashboard that only reports is a dead end. */}
            {/* Five equal rows at desktop width, so the rail ends exactly where
                the chart does. As a plain flex column the tiles kept their
                intrinsic height and left a ragged gap under the last one. */}
            <nav
              aria-label="Where to go next"
              className="flex flex-col gap-3 lg:grid lg:grid-rows-5"
            >
              <NextCard
                label="Library"
                detail={`${num(lib.words)} words · ${num(lib.artists)} artists`}
                href="/app/library.html"
                icon={BookOpen}
              />
              <NextCard
                label="Cron"
                detail={
                  next ? `${next.name} ${until(next.ts)}` : "nothing scheduled"
                }
                href="/app/cron.html"
                icon={Clock}
                count={upcoming.length}
              />
              <NextCard
                label="Markets"
                detail="watchlist, charts and armed alerts"
                href="/app/markets.html"
                icon={LineChart}
              />
              <NextCard
                label="Graph"
                detail="every node and how it connects"
                href="/app/graph.html"
                icon={Network}
              />
              <NextCard
                label="Settings"
                detail={`${(data.chat_summaries ?? []).length} chats configured`}
                href="/app/settings.html"
                icon={Settings2}
              />
            </nav>
          </section>

          <Section title="Second brain">
            <StatTiles tiles={BRAIN_TILES} brain={data.brain} />
            {!BRAIN_TILES.some((t) => pick(data.brain, t.keys) > 0) && (
              <p className="mt-3 mb-0 text-[0.9rem] text-muted">
                All zeros so far — notes, projects and people are filed as chats
                happen.
              </p>
            )}
          </Section>

          {/* Full width, and every row says WHY it is in the brain. It was a
              half-width column of bare titles, which is how a Chinese sentence
              and MAYBANK came to sit there with nothing saying what either was
              doing in a library of song vocabulary. "Filed on its own" is the
              orphan warning: a node with no edge is the thing that reads as
              random, and naming it is what makes the list make sense. */}
          <Section title="Recently filed">
            <Card className="p-5">
              <CardHead
                title="Newest in the library"
                action={
                  <a
                    className="text-[0.85rem] text-muted no-underline hover:text-accent"
                    href="/app/graph.html"
                  >
                    see how it connects →
                  </a>
                }
              />
              <div className="mt-3">
                {(data.recent ?? []).map((r, i) => (
                  <div
                    key={`${r.title}-${i}`}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-line-2 py-2.5 first:border-t-0 first:pt-0"
                  >
                    <span
                      className="size-2 shrink-0 translate-y-[-2px] rounded-full"
                      style={{ background: TYPE_COLOR[r.type] ?? "var(--mem)" }}
                    />
                    {r.url ? (
                      <a
                        href={r.url}
                        className="min-w-0 max-w-full truncate font-medium text-ink no-underline hover:text-accent"
                      >
                        {r.title}
                      </a>
                    ) : (
                      <span className="min-w-0 max-w-full truncate font-medium">
                        {r.title}
                      </span>
                    )}
                    <span className="shrink-0 font-mono text-[0.66rem] uppercase tracking-[0.08em] text-muted">
                      {r.type}
                    </span>
                    {r.sub && (
                      <span className="min-w-0 flex-1 truncate text-[0.88rem] text-read">
                        {r.sub}
                      </span>
                    )}
                    {r.links ? (
                      <span className="shrink-0 text-[0.8rem] text-muted">
                        met in{" "}
                        <span className="text-ink">
                          {r.linked_to || "the library"}
                        </span>
                        {r.links > 1 && ` +${r.links - 1}`}
                      </span>
                    ) : (
                      <span
                        className="shrink-0 text-[0.8rem] text-faint"
                        title="Nothing links to this yet, which is why it reads as random. A node with no connections is a pile, not a brain."
                      >
                        filed on its own
                      </span>
                    )}
                    <span className="shrink-0 text-[0.78rem] text-faint">
                      {ago(r.ts)}
                    </span>
                  </div>
                ))}
                {!(data.recent ?? []).length && (
                  <Empty>Nothing filed yet.</Empty>
                )}
              </div>
            </Card>
          </Section>

          <Section
            title="Conversations"
            action={
              <a
                className="text-[0.85rem] text-muted no-underline hover:text-accent"
                href="/app/settings.html"
              >
                configure →
              </a>
            }
          >
            <div className="grid gap-3 lg:grid-cols-12">
              <Card className="p-5 lg:col-span-7">
                <CardHead title="Chats" />
                <div className="mt-3">
                  {(data.chat_summaries ?? []).map((c, i) => (
                    <div
                      key={`${c.name}-${i}`}
                      className="flex flex-wrap items-center gap-2 border-t border-line-2 py-2.5 first:border-t-0 first:pt-0"
                    >
                      <b className="font-semibold">{c.name}</b>
                      <Badge>{c.kind || "chat"}</Badge>
                      {/* A binding is a configuration, not a conversation. One
                          bound group had never been spoken in and still sat
                          here looking like a chat with history. */}
                      {c.last_seen == null && (
                        <span className="text-[0.78rem] text-faint">
                          configured · nothing said yet
                        </span>
                      )}
                      <span className="ml-auto text-[0.82rem] text-muted">
                        {[
                          `${c.personality} · ${c.mode}`,
                          c.agent === "none" ? "no computer" : null,
                          c.proactive ? "talks first" : null,
                          c.last_seen ? ago(c.last_seen) : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                  ))}
                  {!(data.chat_summaries ?? []).length && (
                    <Empty>No chats configured yet — start in Settings.</Empty>
                  )}
                </div>
              </Card>

              <Card className="p-5 lg:col-span-5">
                <CardHead
                  title="Upcoming"
                  action={
                    <a
                      className="text-[0.82rem] text-muted no-underline hover:text-accent"
                      href="/app/cron.html"
                    >
                      cron →
                    </a>
                  }
                />
                <div className="mt-3">
                  {upcoming.map((j) => (
                    <div
                      key={j.job_id}
                      className="flex items-center gap-3 border-t border-line-2 py-2.5 first:border-t-0 first:pt-0"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {j.name || j.job_id}
                      </span>
                      <span className="shrink-0 text-[0.82rem] text-muted">
                        {until(j.ts)}
                      </span>
                    </div>
                  ))}
                  {!upcoming.length && <Empty>Nothing scheduled.</Empty>}
                </div>
              </Card>
            </div>
          </Section>

          <Section title="System">
            <Card className="p-5">
              {Object.entries(data.services ?? {}).map(([unit, state]) => (
                <ServiceRow
                  key={unit}
                  unit={unit}
                  state={state}
                  onDone={reload}
                />
              ))}
            </Card>
          </Section>
        </>
      )}
    </Shell>
  );
}
