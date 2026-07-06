// The static "How it works" reference modal: methodology prose + glossary.

import { useEffect } from "react";
import { createPortal } from "react-dom";

/** Static reference pane: how every number on the page is derived, plus a glossary of the
 * tags that show up on rows. Opened from the header button, the inline "learn more" links,
 * and the footer. Closes on backdrop click or Escape. */
export function GuideModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // Freeze the page behind the modal so wheel/touch can't scroll it.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div className="guide-backdrop" onClick={onClose}>
      <div
        className="guide"
        role="dialog"
        aria-modal="true"
        aria-label="Methodology and glossary"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="guide-head">
          <h2>How this works</h2>
          <button
            type="button"
            className="guide-x"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="guide-body">
          <section>
            <h3>Where the numbers come from</h3>
            <p>
              Every panel is computed live from public match data on{" "}
              <a
                href="https://deadlock-api.com"
                target="_blank"
                rel="noreferrer"
              >
                deadlock-api.com
              </a>
              , filtered to the <strong>rank floor</strong> and{" "}
              <strong>patch</strong> you select (the newest patch by default).
              Nothing here is hand-curated — change a control and the whole page
              recomputes.
            </p>
            <p>
              A <strong>young patch</strong> has too few games to judge every
              item on its own, so the build is{" "}
              <strong>backfilled from the 30 days before the patch</strong>:
              each item&rsquo;s pre-patch record counts as prior evidence worth
              at most ~a thousand games, and it fades out automatically as the
              new patch accumulates data. Items whose fresh numbers clearly
              disagree with their pre-patch record (the things the patch
              actually changed) borrow far less, and brand-new items are judged
              on fresh data alone. The meta line shows what share of the
              evidence is backfilled, and the <strong>Backfill</strong> toggle
              in the header turns it off — you get the selected window raw, thin
              as it may be.
            </p>
          </section>

          <section>
            <h3>Two kinds of win rate</h3>
            <p>
              <strong>Adjusted win rate</strong> is corrected for{" "}
              <em>net worth at the moment of purchase</em>, so an item doesn’t
              look strong just because the team that was already winning
              happened to buy it. Build and item rows use adjusted rates, and
              show the <strong>± gap versus the hero’s average</strong>.
            </p>
            <p>
              <strong>Raw win rate</strong> is the plain win rate with no
              correction. We fall back to it wherever no adjusted figure exists
              — counter deltas, hero matchups, and whole community builds — so
              in those spots, <strong>lean on the larger samples</strong>.
            </p>
            <p className="fine">
              One honest limit: the correction knows your net worth at purchase,
              not your <em>lead</em> — and players buy expensive items
              disproportionately when already winning. We measured it against a
              win-probability model built from real match timelines: at the
              moment of purchase, a tier-4 buy sits at roughly 56% win
              probability versus ~50% for tier 1. So late, expensive picks stay
              a touch flattered even after adjustment — the{" "}
              <span className="statetag winmore">win more</span> /{" "}
              <span className="statetag comeback">comeback</span> tags are the
              per-pick read on it, and no aggregate correction can fully remove
              it.
            </p>
          </section>

          <section>
            <h3>Reading a pick’s two rates together</h3>
            <p>
              The gap between an item’s raw and adjusted rate tells you when it
              earns its win:
            </p>
            <ul>
              <li>
                <span className="statetag comeback">comeback</span> adjusted ≫
                raw — it holds up even when bought from behind. A safer pick
                when you’re losing.
              </li>
              <li>
                <span className="statetag winmore">win more</span> raw ≫
                adjusted — its win rate leans on already being ahead. Strong
                when snowballing, thin when the game is even.
              </li>
            </ul>
            <p className="fine">
              A pick is only flagged once the gap clears ~3.5 points either way.
            </p>
          </section>

          <section>
            <h3>How the build is chosen</h3>
            <p>
              The build isn’t just the top win rates sorted top to bottom — a
              rarely-built item can show a flashy rate by luck. A few
              corrections keep it honest:
            </p>
            <ul>
              <li>
                <strong>
                  A <span className="role role-universal">CORE</span> seat can
                  be earned by popularity alone.
                </strong>{" "}
                An item ~30%+ of players build every game is seated without a
                win-rate check — at that popularity its own win rate is
                mathematically squeezed toward the average and can’t say much
                either way. It only loses the seat when buyers are demonstrably{" "}
                <em>and</em> meaningfully behind everyone who skipped it — so a
                small red number on a{" "}
                <span className="role role-universal">CORE</span> pick isn’t
                proof it’s bad, just proof the gap isn’t big enough to call.
              </li>
              <li>
                <strong>
                  Small samples are pulled toward the hero’s average.
                </strong>{" "}
                Each win rate is dragged toward the hero average by how little
                data backs it — a pick with thousands of games barely moves, one
                with a few dozen is pulled most of the way. A shiny niche item
                won’t outrank a proven staple on noise.
              </li>
              <li>
                <strong>Picks are ranked cautiously.</strong> Discretionary
                slots are ordered by the win rate we’re fairly sure a pick{" "}
                <em>at least</em> reaches, so something we’re confident about
                beats something that merely <em>might</em> be great.
              </li>
              <li>
                <strong>“Value” means real, not just high.</strong> A pick is
                only labelled a value pick when its edge is big enough to be
                unlikely from chance at that sample size, not just past a fixed
                cutoff. Counters work the same way: an item is tagged as
                answering an enemy by the edge over that matchup we’re{" "}
                <em>confident</em> it has — shrunk toward no-effect by sample —
                so a thin fluke can’t earn a portrait, but a real, moderate
                counter isn’t hidden either.
              </li>
              <li>
                <strong>Items that win together.</strong> Beyond each pick on
                its own, the build leans toward items that win <em>together</em>{" "}
                more than their solo rates predict, and away from redundant
                pairs — so it reads as a coherent kit, not a list of
                individually-good parts.
              </li>
            </ul>
            <p className="fine">
              For the curious: empirical-Bayes shrinkage, lower-confidence-bound
              ranking, significance gates, and a centered pairwise-synergy term.
            </p>
          </section>

          <section>
            <h3>Adjusting for the enemy comp</h3>
            <p>
              Add enemy heroes and the build re-ranks. Picks that answer the
              comp rise and carry the enemy’s portrait — the number is that
              pick’s raw win-rate gain into that hero — while picks that are
              weak into the comp get a <span className="weakcomp">▼</span> flag.
              Staples and per-category soul balance are preserved.
            </p>
            <p>
              A counter is only marked when it beats the matchup&rsquo;s
              expected shift <em>for its own buy timing</em> — some enemies
              spike early and fall off (an item bought at 35 minutes
              doesn&rsquo;t get credit for the enemy&rsquo;s late-game fade),
              and the edge must be large enough to be real at that sample.
              Counter numbers are raw, so they read cleanest one threat at a
              time.
            </p>
          </section>

          <section>
            <h3>Glossary</h3>
            <dl className="glossary">
              <dt>Adjusted WR</dt>
              <dd>
                Win rate corrected for net worth at purchase. Used on every
                build/item row.
              </dd>

              <dt>Raw WR</dt>
              <dd>
                Uncorrected win rate. Used for counters, matchups, and whole
                community builds.
              </dd>

              <dt>Hero avg</dt>
              <dd>
                The population’s baseline win rate for this hero, rank and
                patch. Rows show ± versus it.
              </dd>

              <dt>pulled to average</dt>
              <dd>
                Small-sample win rates are dragged toward the hero average by
                how little data backs them, so a lucky streak on a rarely-built
                item can’t top the list. The fewer the games, the harder the
                pull.
              </dd>

              <dt>confidence ranking</dt>
              <dd>
                Discretionary picks are ordered by the win rate we’re fairly
                sure they <em>at least</em>
                reach — a cautious estimate that builds in sample size — so a
                proven pick beats a shakier high-roller.
              </dd>

              <dt>significant</dt>
              <dd>
                An edge big enough to be unlikely from chance at that sample
                size. It’s the bar a pick clears to be called a value pick or a
                counter — not just beating a fixed number.
              </dd>

              <dt>synergy</dt>
              <dd>
                Two items that win <em>together</em> more (or less) than their
                solo rates predict. The build favours pairs that reinforce each
                other and avoids redundant ones; it’s baked into which picks
                fill the discretionary slots, not shown as its own list.
              </dd>

              <dt>
                <span className="statetag comeback">comeback</span>
              </dt>
              <dd>
                Adjusted ≫ raw — the pick holds up even when you buy it from
                behind.
              </dd>

              <dt>
                <span className="statetag winmore">win more</span>
              </dt>
              <dd>
                Raw ≫ adjusted — the pick’s win rate leans on already being
                ahead.
              </dd>

              <dt>% match</dt>
              <dd>
                How much a community build’s core overlaps ours: shared ÷
                combined core items (Jaccard). Ranks builds “most like ours”, so
                tightly focused builds rank above kitchen-sink ones.
              </dd>

              <dt>
                <span className="role role-universal">CORE</span> tag
              </dt>
              <dd>
                Seated by pick rate (~30%+ of players build it every game), not
                by win rate — at that popularity the win rate can’t move far
                either way, so it isn’t judged on that number unless buyers are
                shown to be significantly and meaningfully behind everyone who
                skipped it. A small red delta here usually isn’t a red flag.
              </dd>

              <dt>core / flex</dt>
              <dd>
                Core = the committed picks (any role, including{" "}
                <span className="role role-universal">CORE</span>,{" "}
                <span className="role role-value">VALUE</span>, and{" "}
                <span className="role role-filler">FILLER</span>); flex =
                situational ones. “core N/M” counts our core picks a community
                build also runs; “flex N/M” counts our situational picks it also
                flags situational (secondary, not ranked).
              </dd>

              <dt>archetype / signature</dt>
              <dd>
                A build style defined by a signature item (e.g. a gun or spirit
                core). “all” blends every build for the hero together.
              </dd>

              <dt>core by X · rush if ahead / buy later</dt>
              <dd>
                A situational pick that becomes core in a later phase.{" "}
                <em>Rush if ahead</em> — buy it early when you’re winning — only
                when it wins about as much bought this early; if it does worse
                early, it’s tagged <em>buy later</em> instead.
              </dd>

              <dt>
                weak into comp <span className="weakcomp">▼</span>
              </dt>
              <dd>
                The pick loses win rate against the enemies you’ve selected, and
                nothing on its row counters them.
              </dd>

              <dt>thin / low sample</dt>
              <dd>Too few matches to trust — treat the number as noisy.</dd>

              <dt>standing slots</dt>
              <dd>
                How many of your active-item slots the build uses, against the
                in-game cap.
              </dd>
            </dl>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
