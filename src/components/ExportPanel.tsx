// "Export to in-game build" — injects the current build into the player's
// cached_hero_builds.kv3 so the in-game shop walks them through it top-to-bottom.

import { useEffect, useState } from "react";
import { encodeHeroBuild } from "../lib/heroBuildExport";
import { injectBuildIntoCache } from "../lib/heroBuildCache";
import {
  ensureWritable,
  forgetBuildFile,
  recallBuildFile,
  rememberBuildFile,
  type BuildFileHandle,
} from "../lib/buildCacheHandle";
import { parseSteamInput } from "../lib/steamId";
import { ModalShell } from "./ModalShell";
import type { GeneratedBuild, ImbueTarget } from "../types";

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
  onClose: () => void;
}) {
  const [status, setStatus] = useState("");
  const [stage, setStage] = useState<"idle" | "working" | "done" | "error">(
    "idle",
  );
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const authorId = parseSteamInput(steamId) ?? undefined;

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
    const blob = encodeHeroBuild(build, {
      name,
      description,
      authorId,
      skillOrder,
      imbues,
    });
    setStatus("Adding your build…");
    const file = await handle.getFile();
    const out = injectBuildIntoCache(
      new Uint8Array(await file.arrayBuffer()),
      blob,
    );
    const writable = await handle.createWritable();
    await writable.write(out);
    await writable.close();
    setStage("done");
    setStatus(
      `Added “${name}” to your build file. Launch Deadlock → ${build.hero.name} → My Builds.`,
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
      const blob = encodeHeroBuild(build, {
        name,
        description,
        authorId,
        skillOrder,
        imbues,
      });
      setStatus("Adding your build…");
      const out = injectBuildIntoCache(
        new Uint8Array(await file.arrayBuffer()),
        blob,
      );
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
        "Done — download below and drop it back into your cfg folder (replace the original).",
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
        Adds <strong>{name}</strong> to your Deadlock build list so the in-game
        shop walks you through it top-to-bottom. Runs entirely in your browser —
        your save file never leaves your machine.
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
            Launch Deadlock → <strong>{build.hero.name}</strong> →{" "}
            <strong>My Builds</strong>.
          </li>
        </ol>
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
                ? "Update in-game build"
                : "Pick file & add build"}
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
          {stage === "working" ? "Working…" : "Choose cached_hero_builds.kv3"}
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

      <details className="export-where">
        <summary>Where is that file?</summary>
        <ul>
          {CACHE_PATHS.map(([os, p]) => (
            <li key={os}>
              <strong>{os}:</strong>{" "}
              <code>
                {p}
                {CACHE_FILENAME}
              </code>
            </li>
          ))}
        </ul>
        <p className="hint">
          Not showing up after launch? Steam Cloud may have reverted it — redo
          it with Deadlock closed, or turn off Steam Cloud for Deadlock while
          importing.
        </p>
      </details>
    </ModalShell>
  );
}
