# Methodology

How Vibelock turns public match statistics into a build, and what is still wrong with the result.

- [Why a build, not a ranking](#why-a-build-not-a-ranking)
- [Slot economy](#slot-economy)
- [Skill order](#skill-order)
- [Archetype split (flex heroes)](#archetype-split-flex-heroes)
- [Patch filter and backfill](#patch-filter-and-backfill)
- [Matchups and counters](#matchups-and-counters)
- [Player profile](#player-profile)
- [Soul pace](#soul-pace)
- [Sessions and loss streaks](#sessions-and-loss-streaks)
- [The Lab](#the-lab)
- [What is still confounded](#what-is-still-confounded)
- [Code map](#code-map)

## Why a build, not a ranking

A build is a correlated set of items under a budget, so the top-N items judged independently do not
compose into one — the highest win-rate items may never be bought together. Each phase is assembled
from four ingredients:

**Budget.** Each phase's target item count and soul spend come from what real players of this hero
and rank actually do.

**Pick-rate core.** The universal every-game core is chosen by pick rate. Items that each appear in
60–70% of builds necessarily co-occur, so co-occurrence is baked in for free. (An earlier version
conditioned each phase on the prior build via `locked_item_ids`, but locking three exact items
matched under 2% of games and emptied the later phases — over-engineering for what pick rate already
gives.)

Same-slot staples that _look_ universal can still be two disjoint camps — two lane styles averaged
together. So co-occurrence is checked against measured joint-purchase counts from
`item-permutation-stats`: two staples whose buyers overlap under ~40% share one core slot. The more
popular one holds it and the other becomes its swap, instead of the build stitching both lines
together.

**Category-balanced fill.** The phase's item count is split across weapon / vitality / spirit in the
same proportion that real players of the hero invest souls, then each category is filled best-first:
every-game staples by pick rate, then value picks (best adjusted win rate above baseline), then
most-bought as a floor so a guaranteed category is never empty.

This is what keeps defensive items in the build. Greens are bought reactively, so they miss both the
pick-rate and the win-rate gates, and a category-blind fill spent the entire budget on weapon and
spirit (Vyper's lane went from 0% vitality to ~17%, which matches real play). Strong-but-rare
leftovers become situational swaps.

**Buy order.** Items within a phase are sorted by average buy time, so reading top to bottom gives
you the buy order.

Each phase shows a souls bar of its weapon/vitality/spirit split. A generate is two parallel API
calls and takes about a second.

## Slot economy

A build is a moving 9–12 item window (9 base slots plus 3 flex slots from Walker kills), not the ~16
raw purchases the phases sum to. Early items get sold or built into bigger ones. The generator marks
**transient** core items — dimmed, dashed border, excluded from the standing-slot count — with a chip
naming the exit route:

**PART** — the item is a component of another recommended pick. Items resolve `component_items` to
ids at load, so this is a shared slot: it upgrades away and refunds its cost ("builds into Opening
Rounds").

**SELL** — sell-fodder, holding a slot only until slots bind. Flagged two ways that mean the same
thing to the player: a cheap (T1) stat-stick that measurably leaves inventory before ~25 minutes with
no in-build upgrade, or, when the standing build still exceeds the 12-slot cap, the weakest cheap
picks (≤T2, ordered by lowest tier, then filler-before-value, then least popular) marked to sell late
for a slot.

No time label is shown for a sale, because `avg_sell_time_s` counts a component being absorbed by its
upgrade as a "sell" — the timing is unreliable.

Items are also de-duplicated across phases, kept in their highest-pick phase. The header shows `N/12
standing slots`. Paradox's 16 raw picks resolve to 10 standing; Victor to 9.

## Skill order

`ability-order-stats` returns full ability-upgrade orders (about 16 point investments) with win/loss
records. Abilities are resolved from the items asset (`type: "ability"`).

Vibelock surfaces the **most common order** rather than the highest win-rate one — it is robust
against small-sample noise and it is the standard build good players run. It renders as a grid: one
row per ability (icon, plus a "max 1st → 4th" label) with numbered pips showing where the points go.
For flex heroes the order is conditioned on the build archetype, since gun and spirit builds skill
differently, and the spirit order often wins more.

The win rate here is raw, so it runs high. Treat it as "follow the standard order", not as an
adjusted metric. Skill-order win rates are also survivorship-inflated and archetype-confounded, and
the de-confounded effect of the order itself is small — under one item's worth — which is why it is
shown descriptively and never priced as a win-rate penalty.

## Archetype split (flex heroes)

Flex heroes (Victor, Vyper, Abrams) have viable gun _and_ spirit builds. Aggregating every player
blends them into a hybrid nobody runs — gun lane, spirit late.

So Vibelock picks the most-played T3 scaling item of each damage type as a _signature_, and
conditions the population on it via `include_item_ids`. Players who bought the big weapon item are
the gun build; the big spirit item, the spirit build. Each conditioned response carries its own win
rate and match count, so the toggle shows which archetype wins and how common it is (Spirit Abrams
55.8% vs Gun 50.8%).

A hero counts as flex only when both archetypes sit in a contested 30–80% share band **and the two
camps are actually distinct**. Vibelock also queries the "bought both signatures" population; if that
overlap exceeds 40% of the smaller camp, the hero is a _hybrid_ — about half of Paradox's "gun"
players also buy the spirit item — and one blended build is shown instead of a misleading split. Mono
heroes (Geist is ~92% spirit) also show a single build.

Every hero shows a one-line build-identity note (flex / hybrid / mono) so it is clear why there is or
is not a toggle.

## Patch filter and backfill

`/v1/patches` maps each patch to a time window. Vibelock defaults to the newest patch and backfills
from the 30 days before it.

The pre-patch window enters as a **power prior** worth at most ~K decided games per item (K is
learned from measured patch-to-patch drift when the data can support the fit; the default is 1,000).
It is discounted per item when the fresh data contradicts it — that is, for the items the patch
actually changed. The borrow self-anneals as the patch accumulates games, and the header shows the
borrowed share ("N% backfilled"), so a day-one build is both complete and honest about its evidence.

## Matchups and counters

**Matchups.** `hero-counter-stats` returns the full hero-vs-hero matrix (it ignores hero filters), so
it is fetched once per rank and patch and filtered client-side. Each enemy's win rate is compared to
the hero's overall win rate. Tough and Favored matchups appear as clickable portrait chips that
toggle into the enemy list, so you can see what to build against them in one click.

Win rate here is whole-game presence, not lane-only — the client sends `same_lane_filter=false`
explicitly, since the API's own default is `true`. (An earlier version of this document called the
parameter a no-op. It never was.) The real lane read is a separate measurement; see below.

**Lane matchups.** Whole-game presence conflates a lane bully with a late-game problem, and those
want opposite responses. So the lane phase is measured directly from the harvested shards, which
carry `assigned_lane` per player: lanes are 2v2 (three lanes, twelve players), and each lane instance
contributes the two sides' soul differential at the 10-minute mark.

A raw "hero A vs hero B" differential is contaminated by both lane _partners_ and mostly restates how
well each hero farms. So the same fix the counter matrix gets: an additive per-hero lane strength is
fitted by least squares over every lane instance (+1 per hero on one side, −1 on the other, target =
the differential), and each pair is reported as its **residual** against what strengths alone predict.
Measured over a full day, the fit absorbs ~76% of the raw variance — pair differentials go from
sd ≈ 438 souls raw to sd ≈ 105 residual — which is the quantitative statement that most of "A beats
B in lane" is just farming ability. Pairs are shrunk toward zero by sample and surface at a 150-soul
floor (~1.7% of a 10-minute net worth).

The **De-noise** toggle fits Bradley-Terry strengths across the whole matrix and re-reads each
matchup as its sample-shrunk _residual_ against what strengths alone predict. A meta hero then stops
showing up as everybody's counter, and "Tough" comes to mean genuine rock-paper-scissors. Strengths
explain the live matrix to about 1 point RMSE, so residuals surface at a 1-point floor rather than a
2-point raw one.

**Counters.** Enter an enemy lineup and `item-stats` is queried with `enemy_hero_ids`, then compared
against the same hero and rank's baseline. Items are sorted by raw win-rate delta, with a hard sample
floor and a warning flag on thin samples. Nothing is silently reordered. The top movers for a phase
are folded into that phase as extra situational picks, each labelled with the core item it should
swap out for.

Two things to know. `item-stats` has no adjusted rate, so counter deltas are raw; the with/without
delta cancels much of the shared confound, but lean on the bigger samples. And a naive "what wins vs
hero X" is dominated by generic strong items, so single-hero, large-sample movers are the trustworthy
signal.

Counters are backfilled on a young patch like the build, with one extra rule: a counter is a
_difference_, so the per-item borrowing discounts are learned once on the base slice and shared into
every enemy-conditioned slice. Otherwise a patch-changed item whose base pulls fresh while its thin
enemy slice stays anchored to pre-patch data would read as a fake counter signal.

Counter edges are also **hero-conditional and marginal**. Disarming Hex against Drifter is −0.9
points pooled, but +3.8 on Sinclair and −5 on gun carries — so counters are never pooled across
heroes. And a counter's win-rate edge is its _marginal_ value, which approaches zero once everybody
already buys it; the adoption uplift shown alongside is what tells you whether an edge is still
unpriced.

## Player profile

An optional Steam account id (the `userdata/<id>` number) is stored only in your browser. It unlocks
a "your heroes" quick-pick row from your last 90 days, and pre-selects the rank floor from your
current badge — until you choose a rank deliberately, which always wins. It is also used as the
author stamp on exported builds.

## The Lab

The Lab holds statistics that the live analytics API cannot answer, because they need per-match soul
trajectories. A nightly GitHub Action samples ~12,000 matches a day across 12 time bins (so the
sample spans EU/NA/Asia peaks), keeps a rolling 30-day window of gzipped NDJSON shards as release
assets, and refits a win-probability surface over it.

The surface gives a win probability for any (team soul lead, game time) pair. From it:

**State-adjusted item value** (`excess`) — an item's win rate minus the mean win probability at the
moments it was actually bought. It asks whether an item beat the situation it was bought into, rather
than whether it was bought in good situations. Reliable at the global level (split-half r ≈ 0.82).

**Hero closing power** — how much a hero wins beyond what their soul lead implies, expressed as a
residual against their plain win rate so it measures style rather than strength. Positive converts
even games; negative wins by snowballing a lead.

Hero-specific _item_ effects are not shown: measured interaction effects are tiny (sd ≈ 0.9 points)
against the sample needed to see them, so the honest answer is that the data does not currently
support per-hero item values.

## Soul pace

A single whole-game souls/min percentile is the wrong resolution for the question players actually
have. A player who wins lane at p60 and then flatlines at p18 once the map opens has the same average
as one who is mediocre throughout, and a completely different problem — so the ladder is read _per
phase_, on the same 600s columns the build itself is filled against.

The bake accumulates two things per (hero, rank), as fixed-width histograms rather than retained
samples (a 30-day window is ~3.2M player-rows):

- **Levels** — net worth at 4-minute ticks, as a p25–p75 band plus the median, and the mean level
  among games won and lost. This is what a single game is plotted against.
- **Window rates** — souls/min _within_ each phase. Not derivable from the levels: the percentile of
  a difference is not the difference of percentiles, and the fall-off is the whole point.

The panel names one phase, and distinguishes two findings that are not the same advice: a **fall-off**
(strong somewhere, much weaker elsewhere — the gap is the finding and it points at a span) and a
**flat deficit** (weak throughout, where naming a "worst phase" would invent a specific problem out
of a general one). When every phase is at or above the ladder it says so rather than manufacturing a
flaw.

Two caveats travel with it into the UI. Levels are **survivorship-biased**: a tick is only recorded
for games that reached it, so the late band describes long games, which are the closer ones. And the
rates are **descriptive, not causal** — farming more in a phase does not cause wins at fixed total net
worth (the measured gradient is ~0), so a weak phase is a place to look, not a lever with a payout.
Nothing in the panel attaches a win rate to a phase.

## Sessions and loss streaks

"Stop playing after two losses" is the most repeated climbing advice there is and the evidence for it
is weaker than its confidence. Three things produce the observed pattern and only one is tilt:
**tilt** (you play worse; stopping helps), **rating regression** (you were above your true skill and
the ladder is correcting; stopping does nothing), and **base rates** (at a 50% win rate a three-loss
streak happens ~12.5% of the time by chance).

A "win rate after N losses" table cannot separate them, so it is shown but explicitly not treated as
the verdict. The separator is time: regression is persistent — a break does not fix an inflated
rating — whereas tilt decays. So among games that all began under the same streak condition, the ones
requeued within 30 minutes are contrasted against the ones played after a 4-hour break. Same streak
state, different rest.

The streak state is deliberately carried _across_ session boundaries: resetting it at a break would
make every rested game a streak-0 game by construction and delete the contrast. A per-account history
is small, so the test reports a 95% interval and names a direction only when that interval excludes
zero — the usual outcome is "not enough games to tell", and saying so is the point. There is no
population baseline because one cannot be built: the shards are a ~12k/day _sample_ of matches, so
consecutive games by the same account are almost never both present.

## What is still confounded

**Who buys the item.** Win-rate builds, this one included, still partly measure _who_ buys an item
rather than what the item does. Good players buy good items. `adjusted_win_rate` shrinks this but does
not erase it.

**When the item is bought.** This is the big one, and it is measured rather than assumed. An item's
raw win rate correlates at r ≈ 0.91 with the win probability that already held at the moment it was
bought — an item's win rate is mostly a statement about the situations it gets bought in. The server's
`adjusted_win_rate` standardizes on _absolute_ net worth, which is a lossy proxy for actually being
ahead, and it only brings that correlation down to r ≈ 0.84.

Absolute net worth predicts winning at AUC 0.70; net-worth _difference_ plus time reaches AUC 0.80.
So expensive, late items stay flattered even after adjustment: win probability at the moment of
purchase climbs from about 50% for tier-1 buys to about 56% for tier-4.

The Lab's `excess` is the metric that actually removes this (its correlation with purchase-state win
probability is r ≈ 0.10), but it is currently a global, roster-wide number rather than a per-hero one,
so the generator still ranks on `adjusted_win_rate`. The per-item **comeback / win more** tags are the
honest per-pick read on the bias in the meantime.

**A corrupt net worth in the lane phase.** There is an upstream data bug: in the per-match data, an
item's `net_worth_at_buy` reports the player's _final_ net worth for their first ~4–5 purchases. Those
are lane buys, so the lane column's `adjusted_win_rate` is standardized against end-of-game wealth.
Golden Goose Egg — 800 souls, bought in the opening minutes — reports an average net worth at buy of
38,179, which is essentially the average net worth at the _end_ of a game. The server duly "adjusts"
its win rate as if a rich player had bought it, taking it from 53.1% raw to 45.7% adjusted: from above
baseline to below it, entirely on bad data.

Vibelock detects this and drops the adjustment for the affected items, ranking and displaying them on
their raw win rate instead. The test is self-calibrating rather than a hardcoded soul value: a node is
flagged when its net worth at buy exceeds twice its _column's_ median. Measured across heroes, columns
1–3 contain no such node, while the lane column has 9–15 per hero. Lane is also the phase where the
confound the adjustment exists to fix is weakest — everyone is poor, so there is little net-worth
variance to confound — which is why falling back to the raw rate is the honest move there. A wrong
adjustment is worse than none.

**Selection and survivorship.** Pick-rate-selected core items win at roughly the baseline by
construction, so discretionary slots are ranked by shrunk adjusted win rate instead. Upgrade paths
are survivorship-inflated. Objective- and urn-related gold is outcome-tied rather than a lever a
player pulls.

## Code map

| Path                          | What it does                                                      |
| ----------------------------- | ----------------------------------------------------------------- |
| `src/api/deadlock.ts`         | Typed API client, retry/backoff, asset caching                    |
| `src/lib/buildGenerator.ts`   | Assembles the budgeted, phased build; tuning constants at the top |
| `src/lib/patchBlend.ts`       | Power-prior backfill for young patches                            |
| `src/lib/counters.ts`         | Enemy-conditioned top movers                                      |
| `src/lib/matchups.ts`         | Hero matchups, Bradley-Terry de-noising                           |
| `src/lib/laneMatchups.ts`     | Lane-phase matchups from the fitted lane-strength residuals       |
| `src/lib/pace.ts`             | Soul pace: ladder curve, per-phase placement, fall-off diagnosis  |
| `src/lib/sessions.ts`         | Sessions, loss streaks, the requeue-vs-rest contrast              |
| `src/lib/archetypes.ts`       | Gun/spirit split for flex heroes                                  |
| `src/lib/skills.ts`           | Ability order                                                     |
| `src/lib/heroBuildExport.ts`  | Serializes a build into Deadlock's local build cache              |
| `scripts/harvest-matches.mjs` | Nightly match sampler (rolling 30-day window)                     |
| `scripts/bake-wp-stats.mjs`   | Fits the win-probability surface and the Lab's statistics         |
| `src/App.tsx`                 | The UI                                                            |
