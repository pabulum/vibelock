// "Export to in-game build" — injects the current build into the player's
// cached_hero_builds.kv3 so the in-game shop walks them through it top-to-bottom.

import { useEffect, useState } from "react";
import { encodeHeroBuild } from "../lib/heroBuildExport";
import {
  injectBuildsIntoCache,
  type InjectResult,
} from "../lib/heroBuildCache";
import type { BatchEntry } from "../lib/exportBatch";
import {
  ensureWritable,
  forgetBuildFile,
  recallBuildFile,
  rememberBuildFile,
  type BuildFileHandle,
} from "../lib/buildCacheHandle";
import { parseSteamInput } from "../lib/steamId";
import { ModalShell } from "./ModalShell";
import type { GeneratedBuild, Hero, ImbueTarget } from "../types";

// File System Access API — not in the default TS DOM lib, so we type only what we call. Present on
// Chromium (lets us edit the file in place); absent elsewhere (we fall back to upload + download).
// The handle shape itself lives in lib/buildCacheHandle, which also persists it.
type FsPicker = (opts?: {
  types?: { description?: string; accept?: Record<string, string[]> }[];
}) => Promise<BuildFileHandle[]>;

const CACHE_FILENAME = "cached_hero_builds.kv3";
const CACHE_PATHS: Array<[string, string]> = [
  ["Linux", "~/.steam/steam/userdata/<id>/1422450/remote/cfg/"],
  [
    "Windows",
    "C:\\Program Files (x86)\\Steam\\userdata\\<id>\\1422450\\remote\\cfg\\",
  ],
  [
    "macOS",
    "~/Library/Application Support/Steam/userdata/<id>/1422450/remote/cfg/",
  ],
];

/** Which platform's path to lead with. A guess, and it only decides ORDERING — every path stays
 * reachable under "Other platforms" — so a wrong answer costs a click, never the information. */
function guessOs(): string {
  const ua =
    (navigator as { userAgentData?: { platform?: string } }).userAgentData
      ?.platform ??
    navigator.userAgent ??
    "";
  if (/mac|darwin|iphone|ipad/i.test(ua)) return "macOS";
  if (/win/i.test(ua)) return "Windows";
  if (/linux|x11|android|cros/i.test(ua)) return "Linux";
  return "Windows"; // the platform most Deadlock players are on
}

/** The full path for one platform, with the player's own account id substituted when we know it —
 * the `<id>` placeholder is the part people get stuck on. */
function pathFor(os: string, accountId: number | undefined): string {
  const dir = CACHE_PATHS.find(([name]) => name === os)?.[1] ?? "";
  return (
    (accountId === undefined ? dir : dir.replace("<id>", String(accountId))) +
    CACHE_FILENAME
  );
}

/** A path as a copy button. It exists to be pasted into a file manager or a shell, so the whole
 * string is the target rather than a copy icon hung off the end of it. */
function PathCopy({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`export-path${copied ? " copied" : ""}`}
      title="Copy this path"
      onClick={() =>
        navigator.clipboard?.writeText(path).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }, noop)
      }
    >
      <code>{path}</code>
      {/* Plain text, not aria-hidden with a visually-hidden twin: the label is already the right
          thing to announce, and it makes the button's accessible name "<path> copy". */}
      <span className="export-copy">{copied ? "copied ✓" : "copy"}</span>
    </button>
  );
}

const noop = () => {};

/**
 * On Chromium it edits the file in place (pick once → written back); elsewhere it downloads an
 * updated copy to drop into the cfg folder. All client-side: the build is serialized to a protobuf
 * ({@link encodeHeroBuild}), the binary KV3 is read in the browser, and the result is written as
 * text KV3 ({@link injectBuildIntoCache}).
 */
export function ExportPanel({
  build,
  skillOrder,
  imbues,
  name,
  description,
  steamId,
  onSteamIdChange,
  extraHeroes,
  buildBatch,
  onClose,
}: {
  build: GeneratedBuild;
  /** The recommended skill (ability) upgrade order, exported alongside the items. */
  skillOrder?: number[];
  /** Community-plurality imbue targets, applied to the exported items in-game. */
  imbues?: Map<number, ImbueTarget>;
  name: string;
  description: string;
  /** Steam account id — owned by App (shared with the header profile control, persisted there).
   * Stamped as the build's author so the logged-in owner can edit/delete it in-game. */
  steamId: string;
  onSteamIdChange: (v: string) => void;
  /** Your other most-played heroes. You queue with three or four and the game assigns one, so the
   * useful unit of export is the queue, not the hero currently on screen. Empty without a profile. */
  extraHeroes: Hero[];
  /** Generate + encode a build for each of `heroes` (lib/exportBatch). Supplied by App, which owns
   * the rank/patch slice those builds have to be generated against. */
  buildBatch: (
    heroes: Hero[],
    onProgress: (done: number, total: number, hero: Hero) => void,
  ) => Promise<BatchEntry[]>;
  onClose: () => void;
}) {
  const [status, setStatus] = useState("");
  const [stage, setStage] = useState<"idle" | "working" | "done" | "error">(
    "idle",
  );
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const authorId = parseSteamInput(steamId) ?? undefined;
  const [guessedOs] = useState(guessOs);

  // Which of your other heroes go into this write. All of them by default: the panel exists to
  // stock the game with the builds you'll actually need, and un-ticking is cheaper than hunting for
  // the ones you want. The hero on screen is always written — it's the build you were looking at,
  // comp re-rank and chosen archetype included, which is why it never goes through the batch.
  const [alsoIds, setAlsoIds] = useState<number[] | null>(null);
  const also = alsoIds ?? extraHeroes.map((h) => h.id);
  const alsoHeroes = extraHeroes.filter((h) => also.includes(h.id));
  const total = 1 + alsoHeroes.length;
  const toggleAlso = (id: number) =>
    setAlsoIds(
      also.includes(id) ? also.filter((x) => x !== id) : [...also, id],
    );

  /** Every build this write should contain: the one on screen, encoded from what you can see, plus
   * a freshly generated one per extra hero. Partial failures are reported, never silent. */
  const collectBlobs = async (): Promise<{
    blobs: Uint8Array[];
    failed: string[];
  }> => {
    const mine = encodeHeroBuild(build, {
      name,
      description,
      authorId,
      skillOrder,
      imbues,
    });
    if (alsoHeroes.length === 0) return { blobs: [mine], failed: [] };
    setStatus(`Generating builds… (1/${total})`);
    const entries = await buildBatch(alsoHeroes, (done) =>
      setStatus(`Generating builds… (${done + 1}/${total})`),
    );
    return {
      blobs: [mine, ...entries.flatMap((e) => (e.blob ? [e.blob] : []))],
      failed: entries.filter((e) => !e.blob).map((e) => e.hero.name),
    };
  };

  /** What the success line says. "Added" and "updated" are different facts to the player — one
   * means a new entry in the in-game browser, the other means the one that was already there is now
   * current — and a re-export is almost always the second. */
  const wroteLine = (r: InjectResult, failed: string[], where: string) => {
    const parts: string[] = [];
    if (r.added)
      parts.push(`Added ${r.added === 1 ? `“${name}”` : `${r.added} builds`}`);
    if (r.replaced)
      parts.push(
        `${parts.length ? "updated" : "Updated"} ${r.replaced} existing Vibelock ${r.replaced === 1 ? "build" : "builds"}`,
      );
    return (
      `${parts.join(", ") || "Wrote no builds"} ${where}` +
      (failed.length ? ` (no data for ${failed.join(", ")})` : "")
    );
  };

  useEffect(
    () => () => {
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    },
    [downloadUrl],
  );

  const picker = (window as unknown as { showOpenFilePicker?: FsPicker })
    .showOpenFilePicker;
  const canEditInPlace = typeof picker === "function";

  // The file we already know about, from a previous export. Its presence is what turns this panel
  // from a five-step ritual into one button, so it's looked up on open — but never permission-
  // checked here (see ensureWritable: that needs a user gesture).
  const [saved, setSaved] = useState<BuildFileHandle | null>(null);
  useEffect(() => {
    if (!canEditInPlace) return;
    let live = true;
    recallBuildFile().then((h) => live && setSaved(h));
    return () => {
      live = false;
    };
  }, [canEditInPlace]);

  /** Write into `handle`, which is either the remembered file or one just picked. */
  const writeInto = async (handle: BuildFileHandle) => {
    const { blobs, failed } = await collectBlobs();
    setStatus("Adding your builds…");
    const file = await handle.getFile();
    const result = injectBuildsIntoCache(
      new Uint8Array(await file.arrayBuffer()),
      blobs,
    );
    const writable = await handle.createWritable();
    await writable.write(result.bytes);
    await writable.close();
    setStage("done");
    setStatus(
      `${wroteLine(result, failed, "in your build file")}. Launch Deadlock → My Builds.`,
    );
  };

  const exportInPlace = async (reuse: boolean) => {
    setStage("working");
    setDownloadUrl(null);
    try {
      let handle = reuse ? saved : null;
      if (handle) {
        // The grant can lapse between sessions; asking here is legal because we're inside the
        // click. A refusal falls through to the picker rather than dead-ending.
        if (!(await ensureWritable(handle))) handle = null;
      }
      if (!handle) {
        setStatus("Pick your cached_hero_builds.kv3…");
        const [picked] = await picker!({
          types: [
            {
              description: "Deadlock build cache",
              accept: { "application/octet-stream": [".kv3"] },
            },
          ],
        });
        handle = picked;
      }
      await writeInto(handle);
      // Only remember a file we actually wrote to — storing a handle that turned out to be the
      // wrong file would make every future export silently wrong.
      void rememberBuildFile(handle);
      setSaved(handle);
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") {
        setStage("idle");
        setStatus("");
        return;
      }
      // A remembered file that's been moved, deleted or revoked can't be recovered from here, and
      // leaving it in place would fail identically every time. Drop it so the next click re-picks.
      if (reuse) {
        void forgetBuildFile();
        setSaved(null);
      }
      setStage("error");
      setStatus(
        `Couldn't write the build: ${(e as Error)?.message ?? e}${reuse ? " — pick the file again." : ""}`,
      );
    }
  };

  const exportToDownload = async (file: File) => {
    setStage("working");
    setDownloadUrl(null);
    try {
      const { blobs, failed } = await collectBlobs();
      setStatus("Adding your builds…");
      const result = injectBuildsIntoCache(
        new Uint8Array(await file.arrayBuffer()),
        blobs,
      );
      const out = result.bytes;
      // Copy into a plain ArrayBuffer so the Blob part is unambiguously typed (the source view may
      // not be ArrayBuffer-backed as far as Blob's types are concerned).
      const buf = new ArrayBuffer(out.byteLength);
      new Uint8Array(buf).set(out);
      setDownloadUrl(
        URL.createObjectURL(
          new Blob([buf], { type: "application/octet-stream" }),
        ),
      );
      setStage("done");
      setStatus(
        `${wroteLine(result, failed, "in the file")} — download it below and drop it back into your cfg folder (replace the original).`,
      );
    } catch (e) {
      setStage("error");
      setStatus(`Couldn't build the file: ${(e as Error)?.message ?? e}`);
    }
  };

  return (
    <ModalShell
      className="export"
      label="Export to in-game build"
      title="Export to in-game build"
      onClose={onClose}
    >
      <p>
        Adds{" "}
        {total === 1 ? (
          <strong>{name}</strong>
        ) : (
          <strong>{total} builds — one per hero below</strong>
        )}{" "}
        to your Deadlock build list so the in-game shop walks you through them
        top-to-bottom. Runs entirely in your browser — your save file never
        leaves your machine.
      </p>
      {/* Once the file is remembered the procedure IS the button, so the numbered list would be
          three steps describing one click. The quit-first warning survives on its own because it's
          the only part that can silently undo the export. */}
      {saved ? (
        <p className="export-known">
          <strong>Fully quit Deadlock first</strong> — it overwrites this file
          on exit. Then one click updates <code>{saved.name}</code>, and the
          build is under <strong>{build.hero.name} → My Builds</strong>.
        </p>
      ) : (
        <ol className="export-steps">
          <li>
            <strong>Fully quit Deadlock</strong> first (the game overwrites this
            file on exit).
          </li>
          <li>
            {canEditInPlace
              ? "Pick your cached_hero_builds.kv3 — we add the build and save it back in place, and remember it so next time is one click."
              : "Pick your cached_hero_builds.kv3, then download the updated file and drop it back into the same folder (back up the original first)."}
          </li>
          <li>
            Launch Deadlock →{" "}
            {total === 1 && <strong>{build.hero.name}</strong>}
            {total === 1 && " → "}
            <strong>My Builds</strong>.
          </li>
        </ol>
      )}

      {/* Why this browser gets the longer route. Editing the file in place needs the File System
          Access API, which only Chromium-based browsers implement — Firefox and Safari can read a
          file you hand them but cannot write back to it, so there is no version of this that skips
          the download there. Said once, plainly, rather than leaving it to look like a bug. */}
      {!canEditInPlace && (
        <p className="export-note">
          Your browser can&rsquo;t save back to the file it opened, so this
          route ends in a download. In a Chromium browser (Chrome, Edge, Brave)
          the same panel edits <code>{CACHE_FILENAME}</code> in place and
          remembers it, making every later export one click.
        </p>
      )}

      {/* You queue with three or four heroes and the game hands you one, so a single-hero export
          asks you to guess. Writing the whole queue costs one extra pass over the same file. */}
      {extraHeroes.length > 0 && (
        <fieldset className="export-also">
          <legend>Builds to write</legend>
          <div className="export-alsorow">
            <label
              className="export-hero on"
              title="The build you're looking at — always written."
            >
              <input type="checkbox" checked disabled readOnly />
              <img src={build.hero.image} alt="" />
              {build.hero.name}
            </label>
            {extraHeroes.map((h) => (
              <label
                key={h.id}
                className={`export-hero${also.includes(h.id) ? " on" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={also.includes(h.id)}
                  disabled={stage === "working"}
                  onChange={() => toggleAlso(h.id)}
                />
                <img src={h.image} alt="" loading="lazy" />
                {h.name}
              </label>
            ))}
          </div>
          <p className="hint">
            Each extra hero is generated at the same rank and patch as the build
            on screen — a few seconds apiece, and free for any you&rsquo;ve
            already looked at this session.
          </p>
        </fieldset>
      )}

      <label className="export-steam">
        <span>
          Steam account ID <span className="hint">(optional, recommended)</span>
        </span>
        <input
          type="text"
          inputMode="numeric"
          placeholder="e.g. 22202 (Gaben's)"
          value={steamId}
          onChange={(e) => onSteamIdChange(e.target.value)}
        />
        <span className="hint">
          The number in your Steam <code>userdata/&lt;id&gt;</code> folder (or
          your profile). Lets you edit &amp; delete the build in-game — without
          it, the build can't be removed except by editing the file.
        </span>
      </label>

      {canEditInPlace ? (
        <>
          <button
            type="button"
            className="export-go"
            disabled={stage === "working"}
            onClick={() => exportInPlace(!!saved)}
          >
            {stage === "working"
              ? "Working…"
              : saved
                ? `Update ${total === 1 ? "in-game build" : `${total} in-game builds`}`
                : `Pick file & add ${total === 1 ? "build" : `${total} builds`}`}
          </button>
          {saved && (
            <p className="export-forget">
              Using <code>{saved.name}</code> ·{" "}
              <button
                type="button"
                className="guidelink"
                onClick={() => {
                  void forgetBuildFile();
                  setSaved(null);
                  setStage("idle");
                  setStatus("");
                }}
              >
                use a different file
              </button>
            </p>
          )}
        </>
      ) : (
        <label className={`export-go ${stage === "working" ? "busy" : ""}`}>
          {stage === "working"
            ? "Working…"
            : `Choose your .kv3 & add ${total === 1 ? "the build" : `${total} builds`}`}
          <input
            type="file"
            accept=".kv3"
            style={{ display: "none" }}
            disabled={stage === "working"}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) exportToDownload(f);
            }}
          />
        </label>
      )}

      {status && <p className={`export-status ${stage}`}>{status}</p>}
      {downloadUrl && (
        <p>
          <a className="export-go" href={downloadUrl} download={CACHE_FILENAME}>
            ⬇ Download {CACHE_FILENAME}
          </a>
        </p>
      )}

      {/* Finding the file is the step that actually stalls people, so the path they need is on the
          page rather than behind a disclosure — with their own account id already substituted, and
          click-to-copy, because the whole point is to paste it into a file manager or a shell. The
          other two platforms stay folded away. */}
      <div className="export-paths">
        <span className="export-pathlbl">Your build file</span>
        <PathCopy path={pathFor(guessedOs, authorId)} />
        {authorId === undefined && (
          <p className="hint">
            Fill in your Steam account ID above and this path completes itself.
            Otherwise <code>&lt;id&gt;</code> is the one folder under{" "}
            <code>userdata/</code> — usually the only one.
          </p>
        )}
        <details className="export-where">
          <summary>Other platforms</summary>
          <ul>
            {CACHE_PATHS.filter(([os]) => os !== guessedOs).map(([os]) => (
              <li key={os}>
                <strong>{os}</strong>
                <PathCopy path={pathFor(os, authorId)} />
              </li>
            ))}
          </ul>
        </details>
        <p className="hint">
          Not showing up after launch? Steam Cloud may have reverted it — redo
          it with Deadlock closed, or turn off Steam Cloud for Deadlock while
          importing.
        </p>
      </div>
    </ModalShell>
  );
}
