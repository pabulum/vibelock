// "Export to in-game build" — injects the current build into the player's
// cached_hero_builds.kv3 so the in-game shop walks them through it top-to-bottom.

import { useEffect, useState } from "react";
import { encodeHeroBuild } from "../lib/heroBuildExport";
import { injectBuildIntoCache } from "../lib/heroBuildCache";
import { parseSteamInput } from "../lib/steamId";
import { ModalShell } from "./ModalShell";
import type { GeneratedBuild, ImbueTarget } from "../types";

// File System Access API — not in the default TS DOM lib, so we type only what we call. Present on
// Chromium (lets us edit the file in place); absent elsewhere (we fall back to upload + download).
interface FsWritable {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}
interface FsFileHandle {
  getFile(): Promise<File>;
  createWritable(): Promise<FsWritable>;
}
type FsPicker = (opts?: {
  types?: { description?: string; accept?: Record<string, string[]> }[];
}) => Promise<FsFileHandle[]>;

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
 * updated copy to drop into the cfg folder. All client-side: Pyodide reads the binary KV3 in the
 * browser ({@link injectBuildIntoCache}), the build is serialized to a protobuf
 * ({@link encodeHeroBuild}), and the result is written as text KV3.
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

  const exportInPlace = async () => {
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
      setStatus("Pick your cached_hero_builds.kv3…");
      const [handle] = await picker!({
        types: [
          {
            description: "Deadlock build cache",
            accept: { "application/octet-stream": [".kv3"] },
          },
        ],
      });
      const file = await handle.getFile();
      const out = await injectBuildIntoCache(
        new Uint8Array(await file.arrayBuffer()),
        blob,
        setStatus,
      );
      const writable = await handle.createWritable();
      await writable.write(out);
      await writable.close();
      setStage("done");
      setStatus(
        `Added “${name}” to your build file. Launch Deadlock → ${build.hero.name} → My Builds.`,
      );
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") {
        setStage("idle");
        setStatus("");
        return;
      }
      setStage("error");
      setStatus(`Couldn't write the build: ${(e as Error)?.message ?? e}`);
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
      const out = await injectBuildIntoCache(
        new Uint8Array(await file.arrayBuffer()),
        blob,
        setStatus,
      );
      // Copy into a plain ArrayBuffer so the Blob part is unambiguously typed (the FS read can be
      // backed by a SharedArrayBuffer-like view, which Blob's types reject).
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
      <ol className="export-steps">
        <li>
          <strong>Fully quit Deadlock</strong> first (the game overwrites this
          file on exit).
        </li>
        <li>
          {canEditInPlace
            ? "Pick your cached_hero_builds.kv3 — we add the build and save it back in place."
            : "Pick your cached_hero_builds.kv3, then download the updated file and drop it back into the same folder (back up the original first)."}
        </li>
        <li>
          Launch Deadlock → <strong>{build.hero.name}</strong> →{" "}
          <strong>My Builds</strong>.
        </li>
      </ol>

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
        <button
          type="button"
          className="export-go"
          disabled={stage === "working"}
          onClick={exportInPlace}
        >
          {stage === "working" ? "Working…" : "Pick file & add build"}
        </button>
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
