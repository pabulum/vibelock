// "Load this in-game": the one community build id worth pasting into the game's build search.
//
// The export path writes our build into the local build cache, which is strictly better when it
// works — but it's a multi-step ritual (open the panel, close the game, write the file, restart),
// and the fastest honest alternative is a build that already exists in-game and already contains
// most of what we recommend. Loading it pre-stocks the shop and carries an ability order, so a game
// can be played off it immediately.
//
// It is a CONVENIENCE, not a recommendation, and the wording keeps that straight: the build is
// chosen by overlap with ours (lib/communityBuilds `pick`), so its win rate is a floor it cleared,
// never a reason it was chosen. Showing the win rate as a headline would imply we're endorsing
// someone else's build over the one we just generated.

import { useState } from "react";
import "./InGamePick.css";
import type { RankedCommunityBuild } from "../types";

export function InGamePick({
  pick,
  unvetted,
  ourCoreCount,
}: {
  pick: RankedCommunityBuild;
  unvetted: boolean;
  /** How many core items our build has, so the overlap reads as "7 of 9" rather than a bare %. */
  ourCoreCount: number;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(String(pick.build.id)).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };

  return (
    <span className="ingamepick">
      <span className="iglabel">In-game</span>
      <button
        type="button"
        className="igid"
        onClick={copy}
        title={
          `Copy build id ${pick.build.id} — paste it into the in-game build search to load ` +
          `“${pick.build.name}”. It shares ${pick.shared} of our ${ourCoreCount} core items and ` +
          `carries its own skill order, so the shop guides you without digging through the full ` +
          `item list. Chosen for overlap with our build` +
          (unvetted
            ? ", and it's lightly played — nothing at this rank had enough games to vet."
            : `; it wins ${(pick.winRate * 100).toFixed(0)}% over ${pick.matches.toLocaleString()} games at this rank, which is a floor it cleared rather than why it was picked.`)
        }
      >
        {copied ? "copied ✓" : `#${pick.build.id}`}
      </button>
      <span className="igshare">
        {pick.shared}/{ourCoreCount} core
        {unvetted && <span className="igthin"> · lightly played</span>}
      </span>
    </span>
  );
}
