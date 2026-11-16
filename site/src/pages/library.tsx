import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Pause,
  Play,
  Search,
} from "lucide-react";
import type { LibDetail, LibIndex, LibItem, SongLine } from "@/lib/api";
import { get, post, mediaSrc } from "@/lib/api";
import { toast, Toaster, useApi } from "@/lib/hooks";
import { cn, num } from "@/lib/utils";
import { Shell } from "@/components/shell";
import {
  Button,
  Card,
  ConfirmAction,
  Empty,
  Kicker,
  Section,
  Spinner,
  Tabs,
} from "@/components/ui";

/* The library was the last surface still served as generated HTML — 335 flat
   pages that had to be restyled by hand every time the app moved. It is now
   one page over /api/library, so a change to the design system reaches it for
   free, and the two things the old pages did that a list cannot — stepping
   word to word, and reading a song line by line without losing your place —
   are components here rather than per-page JavaScript. */

const TYPE_LABEL: Record<string, string> = {
  song: "Songs",
  vocab: "Words",
  grammar: "Grammar",
  artist: "Artists",
  note: "Notes",
  topic: "Topics",
  source: "Sources",
  reminder: "Reminders",
  transcript: "Transcripts",
  person: "People",
  project: "Projects",
  place: "Places",
};

/* Every tab is a plural noun in title case, so a type missing from the map
   must not sit in the row as the raw lowercase singular it is stored as —
   "reminder" and "source" next to "Songs" and "Grammar" read as a rendering
   fault, which is what they were. Types are added faster than this map is,
   so the fallback has to be presentable on its own rather than a reminder to
   come back and edit. */
function typeLabel(t: string): string {
  if (TYPE_LABEL[t]) return TYPE_LABEL[t];
  const one = t.charAt(0).toUpperCase() + t.slice(1);
  if (/(s|x|z|ch|sh)$/.test(t)) return `${one}es`;
  if (/[^aeiou]y$/.test(t)) return `${one.slice(0, -1)}ies`;
  return `${one}s`;
}
const TYPE_ONE: Record<string, string> = {
  song: "song",
  vocab: "word",
  grammar: "pattern",
  artist: "artist",
  note: "note",
  topic: "topic",
};
/* The data hues from DESIGN.md, as the classes Tailwind has already compiled.
   A type's colour is text and a hairline, never a fill — squint and the page
   still reads monochrome. */
const TYPE_TINT: Record<string, { text: string; ring: string }> = {
  song: { text: "text-song", ring: "border-song/30" },
  vocab: { text: "text-vocab", ring: "border-vocab/30" },
  grammar: { text: "text-gram", ring: "border-gram/30" },
  artist: { text: "text-artist", ring: "border-artist/30" },
  note: { text: "text-mem", ring: "border-mem/30" },
  topic: { text: "text-mem", ring: "border-mem/30" },
};

/* ── routing ──────────────────────────────────────────────────────────────
   Hash routes, not a router: one entry file, real back-button behaviour, and
   a link a reader can paste. `#/song:lemon` opens an item; `#songs` a list. */
function useHashRoute() {
  const read = () => decodeURIComponent(window.location.hash.replace(/^#/, ""));
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = useCallback((to: string) => {
    window.location.hash = to ? `#${to}` : "";
  }, []);
  return [route, go] as const;
}

/* ── song reading ─────────────────────────────────────────────────────── */

/** Jump and autoscroll. A 40-line song is longer than a viewport, and the
 *  reader is following along with audio — losing your place is the whole
 *  failure mode these exist to prevent. */
function ReadingControls() {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const raf = useRef(0);
  /* Sub-pixel remainder. At a readable 55px/s a frame is ~0.9px, and writing
     that straight to a scroll offset rounds it away every single frame — the
     page sat at 0 forever while the loop ran perfectly. The fraction has to
     live here and only whole pixels reach the DOM. */
  const carry = useRef(0);

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(now - last, 100); // a backgrounded tab must not lurch
      last = now;
      // px per second, so the multiplier means the same thing on any display
      // rather than running twice as fast on a 120Hz panel.
      carry.current += (55 * speed * dt) / 1000;
      const whole = Math.trunc(carry.current);
      if (whole) {
        carry.current -= whole;
        window.scrollBy(0, whole);
      }
      if (
        window.innerHeight + window.scrollY >=
        document.body.scrollHeight - 2
      ) {
        setPlaying(false);
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, speed]);

  const jump = (to: "top" | "bottom") => {
    setPlaying(false); // a jump ends the crawl, never fights it
    window.scrollTo({
      top: to === "top" ? 0 : document.body.scrollHeight,
      behavior: "smooth",
    });
  };

  return (
    <div className="glass sticky top-2 z-10 mb-6 flex flex-wrap items-center gap-2 rounded-card p-2">
      <Button size="sm" variant="ghost" onClick={() => jump("top")}>
        <ChevronUp /> top
      </Button>
      <Button size="sm" variant="ghost" onClick={() => jump("bottom")}>
        <ChevronDown /> bottom
      </Button>
      <Button
        size="sm"
        variant={playing ? "primary" : "ghost"}
        onClick={() => setPlaying((p) => !p)}
      >
        {playing ? <Pause /> : <Play />}
        {playing ? "pause" : "autoscroll"}
      </Button>
      <label className="ml-auto flex items-center gap-2 text-[0.82rem] text-muted">
        speed
        <input
          type="range"
          min={0.4}
          max={3}
          step={0.2}
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
          className="w-28 accent-[var(--accent)]"
        />
        <span className="tnum w-8">{speed.toFixed(1)}×</span>
      </label>
    </div>
  );
}

/* 警告（けいこく） is what chat can manage. A browser can set the reading above
   the kanji where it belongs, and the generated pages did — reading a lyric
   with its furigana spliced into the middle of the line as parentheses is the
   thing that made this view worth building in the first place. Same pattern as
   FURIGANA_RE in brain/songs.py: kanji run, then kana in either bracket. */
const FURIGANA = /([一-鿿々]+)[（(]([ぁ-ゖァ-ヺー゛゜]+)[）)]/g;

function Ruby({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  let pos = 0;
  for (const m of text.matchAll(FURIGANA)) {
    if (m.index > pos) out.push(text.slice(pos, m.index));
    out.push(
      <ruby key={m.index}>
        {m[1]}
        <rt>{m[2]}</rt>
      </ruby>,
    );
    pos = m.index + m[0].length;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return <>{out}</>;
}

/** A line's vocab/grammar wikilinks, as chips that go where they point.
 *  Every term on a line is also an edge of the song, so the item's own links
 *  resolve the title to an id — no second request to make them clickable. */
function LineTerms({
  line,
  index,
  go,
}: {
  line: SongLine;
  index: Map<string, LibItem>;
  go: (to: string) => void;
}) {
  const terms = [
    ...(line.vocab ?? []).map((t) => ({
      t: t.replace(/\[\[|\]\]/g, ""),
      g: false,
    })),
    ...(line.grammar ?? []).map((t) => ({
      t: t.replace(/\[\[|\]\]/g, ""),
      g: true,
    })),
  ];
  if (!terms.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5 pl-0 sm:pl-8">
      {terms.map(({ t, g }) => {
        const hit = index.get(t);
        const tint = g ? TYPE_TINT.grammar : TYPE_TINT.vocab;
        return (
          <button
            key={(g ? "g:" : "v:") + t}
            type="button"
            disabled={!hit}
            onClick={() => hit && go(hit.id)}
            className={cn(
              "rounded-full border border-line px-2.5 py-1 text-[0.82rem] transition-colors",
              hit ? "cursor-pointer hover:border-line-strong" : "opacity-60",
              tint.text,
            )}
            title={hit?.sub || undefined}
          >
            {t}
            {hit?.sub && (
              <span className="ml-1.5 text-faint">
                {hit.sub.split(" · ").pop()}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* The reading surface, at reading scale. It is not a card and it is not a
   scroll box: the lyric IS the page here, so it runs the full column and the
   window scrolls, which is what the generated pages did and what autoscroll
   was built to drive. Boxing it inside a fixed-height pane put a 40-line song
   through a letterbox. */
function SongBody({
  lines,
  index,
  go,
}: {
  lines: SongLine[];
  index: Map<string, LibItem>;
  go: (to: string) => void;
}) {
  return (
    <>
      <ReadingControls />
      <ol className="m-0 flex list-none flex-col p-0">
        {lines.map((l) => (
          <li
            key={l.i}
            className="relative border-t border-line-2 py-6 pl-0 first:border-t-0 first:pt-1 sm:pl-12"
          >
            <span className="tnum text-[0.72rem] tracking-[0.03em] text-faint sm:absolute sm:top-7 sm:left-0 sm:w-8 sm:text-right">
              {l.i}
            </span>
            {/* Leading is generous because ruby sits ABOVE the line: tighten
                this and the readings collide with the line before. */}
            <p className="mt-1 mb-2 text-[clamp(1.6rem,1.1vw+1.25rem,2.2rem)] leading-[2.1] font-normal sm:mt-0">
              <Ruby text={l.ja} />
            </p>
            {l.reading && (
              <p className="m-0 mb-2 text-[0.84rem] tracking-[0.04em] text-faint">
                {l.reading}
              </p>
            )}
            {l.zh && (
              <p className="m-0 flex items-baseline gap-2.5 text-[1.02rem] text-read">
                <span className="w-5 shrink-0 text-[0.62rem] tracking-[0.08em] text-faint">
                  中
                </span>
                <span>{l.zh}</span>
              </p>
            )}
            {l.en && (
              <p className="m-0 mt-0.5 flex items-baseline gap-2.5 text-[0.96rem] text-read">
                <span className="w-5 shrink-0 text-[0.62rem] tracking-[0.08em] text-faint uppercase">
                  en
                </span>
                <span>{l.en}</span>
              </p>
            )}
            {l.notes && (
              <p className="m-0 mt-3 border-l-2 border-line pl-4 text-[0.86rem] text-muted italic sm:ml-8">
                {l.notes}
              </p>
            )}
            <LineTerms line={l} index={index} go={go} />
          </li>
        ))}
      </ol>
    </>
  );
}

/* ── item view ────────────────────────────────────────────────────────── */

/* A note IS its prose, so the body renders as the paragraphs it is written as
   — "**Japanese**" / "**Chinese**" heading lines and the line itself. Two
   constructs are not prose and were being printed as their own source text:
   the "### Images" heading a picture node opens with, and the markdown image
   links beneath it. A library that stores pictures and then shows you their
   URLs is not storing pictures, so images render as images. Alt text stays in
   `alt` rather than becoming a caption — it is the search-result title that
   found the picture, which is noise on the page and readable to a screen
   reader. */
const MD_IMAGE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

function NoteBody({ body }: { body: string }) {
  const blocks: React.ReactNode[] = [];
  let para: string[] = [];
  let shots: { alt: string; src: string }[] = [];

  const flushPara = () => {
    if (!para.length) return;
    const text = para.join(" ").trim();
    para = [];
    if (!text) return;
    blocks.push(
      <p
        key={`p${blocks.length}`}
        className={cn(
          "my-2 text-[1.05rem] leading-relaxed",
          /^\*\*.+\*\*$/.test(text)
            ? "font-mono text-[0.7rem] tracking-[0.08em] text-muted uppercase"
            : "text-read",
        )}
      >
        {text.replace(/^\*\*(.+)\*\*$/, "$1")}
      </p>,
    );
  };
  const flushShots = () => {
    if (!shots.length) return;
    const mine = shots;
    shots = [];
    blocks.push(
      <div
        key={`g${blocks.length}`}
        className="my-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
      >
        {mine.map((s) => (
          <a
            key={s.src}
            href={s.src}
            target="_blank"
            rel="noreferrer noopener"
            className="block overflow-hidden rounded-card border border-line bg-sunk transition-colors hover:border-line-strong"
          >
            <img
              src={s.src}
              alt={s.alt}
              loading="lazy"
              className="block h-44 w-full bg-sunk object-cover"
            />
          </a>
        ))}
      </div>,
    );
  };

  for (const raw of body.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    const found = [...line.matchAll(MD_IMAGE)];
    if (found.length) {
      flushPara();
      for (const m of found) shots.push({ alt: m[1], src: mediaSrc(m[2]) });
      continue;
    }
    flushShots();
    const head = /^#{1,6}\s+(.+)$/.exec(line);
    if (head) {
      flushPara();
      blocks.push(
        <p
          key={`h${blocks.length}`}
          className="mt-5 mb-1 font-mono text-[0.7rem] tracking-[0.08em] text-muted uppercase"
        >
          {head[1]}
        </p>,
      );
      continue;
    }
    if (!line) flushPara();
    else para.push(line.replace(/^[-*]\s+/, ""));
  }
  flushPara();
  flushShots();

  return <div className="mt-4 max-w-[68ch]">{blocks}</div>;
}

function ItemView({ id, go }: { id: string; go: (to: string) => void }) {
  const [d, setD] = useState<LibDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setD(null);
    setErr(null);
    get<LibDetail>(`/api/library/item?id=${encodeURIComponent(id)}`)
      .then((r) => live && setD(r))
      .catch((e: Error) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [id]);

  /* Steppers on the keyboard too: 249 words is a lot of clicking, and this is
     the one place the reader is doing the same action over and over. */
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "ArrowLeft" && d?.prev) go(d.prev.id);
      if (e.key === "ArrowRight" && d?.next) go(d.next.id);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [d, go]);

  if (err) return <Card className="border-down/40 p-4 text-down">{err}</Card>;
  if (!d)
    return (
      <div className="flex items-center gap-2 text-muted">
        <Spinner /> loading…
      </div>
    );

  const { item, links, prev, next, position } = d;
  const tint = TYPE_TINT[item.type] ?? TYPE_TINT.note;
  const data = item.data;
  const body = item.body ?? "";
  const lines = data.lines ?? [];
  const byTitle = new Map(links.map((l) => [l.title, l]));

  const stepper = (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant="ghost"
        disabled={!prev}
        onClick={() => prev && go(prev.id)}
      >
        <ArrowLeft />
        <span className="max-w-40 truncate">{prev?.title ?? "start"}</span>
      </Button>
      <span className="tnum shrink-0 text-[0.8rem] text-faint">
        {position.at} / {position.of}
      </span>
      <Button
        size="sm"
        variant="ghost"
        disabled={!next}
        onClick={() => next && go(next.id)}
      >
        <span className="max-w-40 truncate">{next?.title ?? "end"}</span>
        <ArrowRight />
      </Button>
    </div>
  );

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => go(item.type === "song" ? "song" : item.type)}
        >
          <ArrowLeft /> {typeLabel(item.type)}
        </Button>
        {stepper}
      </div>

      {/* The kicker says WHAT this is; whose it is belongs beside it. Until
          sources were scoped to the chat that filed them they were all one
          shared pile, so there was nothing to print here and no way to tell
          one chat's reels from another's. */}
      <Kicker className={tint.text}>
        {TYPE_ONE[item.type] ?? item.type}
        {item.owner && item.owner !== "shared library"
          ? ` · ${item.owner}`
          : ""}
      </Kicker>
      {/* h2, not h1: the shell already gives the page its heading, and two
          h1s is a page that cannot say what it is about. */}
      <h2 className="mt-1 mb-1 font-serif text-[2rem] leading-tight font-medium">
        {item.title}
      </h2>
      {data.reading && (
        <p className="mt-0 mb-1 text-[1.05rem] text-read">{data.reading}</p>
      )}
      {data.artist && (
        <p className="mt-0 mb-1 text-muted">
          {data.artist.replace(/\[\[|\]\]/g, "")}
        </p>
      )}

      {(data.gloss_en ||
        data.gloss_zh ||
        data.explanation ||
        data.explanation_zh) && (
        <Card className={cn("mt-4 p-5", tint.ring)}>
          {data.gloss_en && (
            <p className="m-0 text-[1.1rem]">{data.gloss_en}</p>
          )}
          {data.gloss_zh && (
            <p className="m-0 mt-1 text-read">{data.gloss_zh}</p>
          )}
          {data.explanation && (
            <p className="m-0 text-[1.05rem]">{data.explanation}</p>
          )}
          {data.explanation_zh && (
            <p className="m-0 mt-1 text-read">{data.explanation_zh}</p>
          )}
          {data.pos && (
            <p className="m-0 mt-2 text-[0.82rem] text-faint">{data.pos}</p>
          )}
        </Card>
      )}

      {body && <NoteBody body={body} />}

      {lines.length > 0 && (
        <Section title={`Line by line · ${lines.length}`}>
          <SongBody lines={lines} index={byTitle} go={go} />
        </Section>
      )}

      {links.length > 0 && (
        <Section title={`Connected · ${links.length}`}>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {links.map((l) => (
              <ItemRow key={`${l.rel}-${l.id}`} item={l} go={go} />
            ))}
          </div>
        </Section>
      )}

      <div className="mt-8 flex justify-center">{stepper}</div>
    </>
  );
}

/* ── lists ────────────────────────────────────────────────────────────── */

function ItemRow({
  item,
  go,
  onGone,
}: {
  item: LibItem;
  go: (to: string) => void;
  /* Absent where the row is a navigation aid rather than a management surface — the
     neighbours strip inside an item exists to move you around, and a delete
     control there would be a destructive action offered in passing. */
  onGone?: () => void;
}) {
  const tint = TYPE_TINT[item.type] ?? TYPE_TINT.note;
  /* Two steps, because there is no undo — the file is unlinked and the row
     deleted. ConfirmAction owns both, so this is the same strip the cron page
     and the service list use. The comment here used to promise "anything else
     disarms it", which was never true of the code: nothing but a 4s timer
     dismissed it, and there was no Escape and no outside click. */
  const [busy, setBusy] = useState(false);

  /* `reviewed` is the one lifecycle a library entry has, and it round-trips
     through the API, so the card owns an optimistic copy rather than waiting
     on a refetch of the whole 600-row index for a one-field change. */
  const [reviewed, setReviewed] = useState(item.reviewed);
  useEffect(() => setReviewed(item.reviewed), [item.reviewed]);

  async function toggleReviewed() {
    const want = !reviewed;
    setBusy(true);
    setReviewed(want);
    try {
      await post("/api/library", {
        action: "review_node",
        id: item.id,
        reviewed: want,
      });
      toast(want ? "marked checked ✓" : "marked unchecked");
    } catch (e) {
      setReviewed(!want); /* put the chip back where it was */
      toast((e as Error).message, false);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      /* A song is refused by the API with a 409 rather than deleted, because
         removing one also removes the words no other song references. That is
         forget_song's job and it is a different question. */
      await post("/api/library", { action: "forget_node", id: item.id });
      toast("removed ✓");
      onGone?.();
    } catch (e) {
      toast((e as Error).message, false);
      throw e; // keep the confirm open on a refused delete
    } finally {
      setBusy(false);
    }
  }

  const meta = [
    /* Whose entry this is. A page that lists one chat's reels beside another's
       without saying which is a page you cannot act on — and until sources were
       scoped, they were genuinely all one pile. "shared library" is not a chat,
       so it is not printed. */
    item.owner && item.owner !== "shared library" ? item.owner : null,
    item.lines != null ? `${item.lines} lines` : null,
    /* A neighbour arrives without a link count of its own — printing a bare
       "links" there reads as a number that failed to load. */
    item.links != null
      ? `${item.links} link${item.links === 1 ? "" : "s"}`
      : null,
    /* When it was first used in a lesson. brain_gaps has read this all along
       to decide what to teach next; the page never showed it. */
    item.taught ? `taught ${item.taught}` : null,
    /* And when it was collected. The list is ordered newest-first by this
       date; printing it is what turns "these are in some order" into "these
       are in date order", which is the difference between a list you trust
       and one that looks shuffled. Last in the row: it is the weakest of
       these facts, and it should not lead. */
    item.when ? item.when : null,
  ].filter(Boolean);

  /* Songs are deliberately not offered this: deleting one also removes every
     word and pattern no other song still references, which is a different
     question and belongs to forget_song. Offering the same control for both
     would make the destructive one look routine. */
  const canRemove = item.type !== "song" && !!onGone;

  return (
    /* A div, not a button: the control lives inside the card and a button
       cannot contain a button. The card body keeps the whole clickable area it
       had, and the footer is a real row rather than an overlay — the control
       used to be absolutely positioned in the corner, where it sat on top of
       long titles and was invisible until hover, which on a touch screen means
       invisible full stop. */
    <div
      className={cn(
        "flex flex-col rounded-card border bg-card transition-colors",
        "hover:border-line-strong focus-within:border-line-strong",
        tint.ring,
      )}
    >
      <button
        type="button"
        onClick={() => go(item.id)}
        className="flex w-full cursor-pointer flex-col items-start gap-0.5 px-4 pt-4 text-left"
      >
        <span className={cn("font-medium", tint.text)}>{item.title}</span>
        {item.sub && (
          <span className="line-clamp-2 text-[0.86rem] text-muted">
            {item.sub}
          </span>
        )}
      </button>

      <div className="flex min-h-9 items-center gap-2 px-4 pb-3 pt-1">
        {meta.length > 0 && (
          <span className="text-[0.75rem] text-faint">{meta.join(" · ")}</span>
        )}
        {/* Only kinds that carry provenance get a chip — the API omits the
            field entirely for a source or a transcript, which is filed rather
            than checked, so `undefined` correctly renders nothing. An
            unchecked gloss is the one that wants attention, so it is the one
            that gets colour. */}
        {reviewed !== undefined && (
          <button
            type="button"
            disabled={busy}
            aria-pressed={reviewed}
            aria-label={
              reviewed
                ? `${item.title} is checked — mark unchecked`
                : `${item.title} is unchecked — mark checked`
            }
            onClick={() => void toggleReviewed()}
            className={cn(
              "shrink-0 rounded-card px-2 py-1 text-[0.75rem]",
              "transition-colors disabled:opacity-40",
              reviewed
                ? "text-faint hover:bg-ok/10 hover:text-ok"
                : "bg-warn/15 font-medium text-warn hover:bg-warn/25",
            )}
          >
            {reviewed ? "checked ✓" : "unchecked"}
          </button>
        )}
        {canRemove && (
          <ConfirmAction
            className="ml-auto"
            label="remove"
            confirmLabel="Remove"
            question={`Remove “${item.title}”?`}
            onConfirm={remove}
          />
        )}
      </div>
    </div>
  );
}

function Overview({ data, go }: { data: LibIndex; go: (to: string) => void }) {
  const led = data.ledger?.total;
  const k = (n?: number) =>
    n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  return (
    <>
      <Section title="In the library">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {data.types.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => go(t)}
              className="cursor-pointer rounded-card border border-line bg-card p-4 text-left transition-colors hover:border-line-strong"
            >
              <b className="block font-serif text-[2rem] leading-none font-normal">
                {num(data.counts[t])}
              </b>
              <span className="mt-1 block font-mono text-[0.7rem] tracking-[0.08em] text-muted uppercase">
                {typeLabel(t)}
              </span>
            </button>
          ))}
          <div className="rounded-card border border-line bg-card p-4">
            <b className="block font-serif text-[2rem] leading-none font-normal">
              {num(data.edges)}
            </b>
            <span className="mt-1 block font-mono text-[0.7rem] tracking-[0.08em] text-muted uppercase">
              Links
            </span>
          </div>
        </div>
      </Section>

      {led && (
        <Section title="What it cost">
          <Card className="p-5">
            <p className="mt-0 mb-4 max-w-prose text-[0.9rem] text-muted">
              The songs the library holds now, and what building them cost —
              fetching, glossing and filing, not talking about them afterwards.
              Every figure came back from the CLI on a turn that had already
              happened, so nothing here is estimated and showing it costs
              nothing.
            </p>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
              {[
                ["turns", num(led.turns)],
                ["input", k(led.billed_input)],
                ["cached", k(led.cache_read)],
                ["output", k(led.output)],
                ["cost", `$${(led.cost_usd ?? 0).toFixed(2)}`],
              ].map(([label, value]) => (
                <div key={label}>
                  <b className="block font-serif text-[1.6rem] leading-none font-normal">
                    {value}
                  </b>
                  <span className="mt-1 block font-mono text-[0.7rem] tracking-[0.08em] text-muted uppercase">
                    {label}
                  </span>
                </div>
              ))}
            </div>
            {!!data.ledger?.by_song?.length && (
              <div className="mt-5 overflow-x-auto">
                <table className="w-full border-collapse text-[0.86rem]">
                  <thead>
                    <tr className="text-muted">
                      {[
                        "song",
                        "turns",
                        "input",
                        "cached",
                        "output",
                        "cost",
                      ].map((h, i) => (
                        <th
                          key={h}
                          className={cn(
                            "border-b border-line-2 py-2 font-mono text-[0.7rem] font-medium tracking-[0.08em] uppercase",
                            i === 0 ? "text-left" : "text-right",
                          )}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="tnum">
                    {data.ledger.by_song.map((r) => (
                      <tr key={r.name}>
                        <td className="border-b border-line-2 py-2 text-left">
                          {r.name}
                        </td>
                        <td className="border-b border-line-2 py-2 text-right">
                          {r.turns}
                        </td>
                        <td className="border-b border-line-2 py-2 text-right">
                          {k(r.billed_input)}
                        </td>
                        <td className="border-b border-line-2 py-2 text-right">
                          {k(r.cache_read)}
                        </td>
                        <td className="border-b border-line-2 py-2 text-right">
                          {k(r.output)}
                        </td>
                        <td className="border-b border-line-2 py-2 text-right font-semibold">
                          ${r.cost_usd.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!!data.ledger?.chat?.turns && (
              /* Named and kept OUT of the figures above. The router tags every
                 turn with whatever song is current, so ordinary conversation
                 inherits the label — folding it into the build cost made the
                 library look several times more expensive than it is. */
              <p className="mt-4 mb-0 max-w-prose text-[0.86rem] text-faint">
                A further{" "}
                <b className="tnum font-medium text-muted">
                  ${data.ledger.chat.cost_usd.toFixed(2)}
                </b>{" "}
                went on <span className="tnum">{data.ledger.chat.turns}</span>{" "}
                turns that talked about these songs rather than built them. That
                is conversation, and it is counted here so it is not counted
                twice.
              </p>
            )}
          </Card>
        </Section>
      )}
    </>
  );
}

/* ── page ─────────────────────────────────────────────────────────────── */

export default function LibraryPage() {
  const idx = useApi<LibIndex>("/api/library/index");
  const [route, go] = useHashRoute();
  const [q, setQ] = useState("");

  const data = idx.data;
  const isItem = route.includes(":");
  const tab = isItem ? "" : route || "overview";

  /* One filter over everything, because "which list is 苦い in" is exactly the
     question the reader does not have an answer to yet. */
  const hits = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term || !data) return null;
    const all = Object.values(data.items).flat();
    const found = all.filter(
      (i) =>
        i.title.toLowerCase().includes(term) ||
        i.sub.toLowerCase().includes(term),
    );
    // The list is capped, the COUNT is not. Reporting the capped length as the
    // number of matches told somebody searching a large library that there
    // were exactly 120 hits, every time, however many there really were.
    return { rows: found.slice(0, 120), total: found.length };
  }, [q, data]);

  return (
    <Shell
      page="library"
      title="Library"
      hero={
        data && data.types.length
          ? [
              { n: num(data.counts.vocab ?? 0) },
              { t: " words, " },
              { n: num(data.counts.grammar ?? 0) },
              { t: " patterns and " },
              { n: num(data.counts.song ?? 0) },
              { t: " songs, cross-linked " },
              { n: num(data.edges) },
              { t: " ways" },
            ]
          : [{ t: data ? "Nothing filed yet" : "Loading the library…" }]
      }
    >
      <Toaster />
      {idx.error && (
        <Card className="border-down/40 p-4 text-down">
          Could not load the library: {idx.error}
        </Card>
      )}
      {idx.loading && !data && (
        <div className="flex items-center gap-2 text-muted">
          <Spinner /> loading…
        </div>
      )}

      {data && (
        <>
          <div className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
            <Tabs
              label="Library sections"
              value={tab}
              onChange={(t) => go(t === "overview" ? "" : t)}
              tabs={[
                { key: "overview", label: "Overview" },
                ...data.types.map((t) => ({
                  key: t,
                  label: typeLabel(t),
                  count: data.counts[t],
                })),
              ]}
              className="min-w-0 flex-1"
            />
            <div className="relative w-full pb-2 sm:w-72">
              <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
              <input
                value={q}
                placeholder="find anything…"
                onChange={(e) => setQ(e.target.value)}
                className="min-h-10 w-full rounded-card border border-line bg-sunk pr-3 pl-9 text-ink"
              />
            </div>
          </div>

          {hits ? (
            <Section
              title={
                `${hits.total} match${hits.total === 1 ? "" : "es"}` +
                (hits.total > hits.rows.length
                  ? ` — showing ${hits.rows.length}`
                  : "")
              }
            >
              {hits.rows.length ? (
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {hits.rows.map((i) => (
                    <ItemRow
                      key={i.id}
                      item={i}
                      go={go}
                      onGone={() => void idx.reload()}
                    />
                  ))}
                </div>
              ) : (
                <Empty>Nothing filed under that yet.</Empty>
              )}
            </Section>
          ) : isItem ? (
            <ItemView id={route} go={go} />
          ) : tab === "overview" ? (
            <Overview data={data} go={go} />
          ) : (
            <Section title={`${typeLabel(tab)} · ${num(data.counts[tab])}`}>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {(data.items[tab] ?? []).map((i) => (
                  <ItemRow
                    key={i.id}
                    item={i}
                    go={go}
                    onGone={() => void idx.reload()}
                  />
                ))}
              </div>
            </Section>
          )}
        </>
      )}
    </Shell>
  );
}
