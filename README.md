# Vibelock

A local, data-driven build generator for [Deadlock](https://store.steampowered.com/app/1422450/Deadlock/).
Pick a hero and a rank floor and it produces a **phased, annotated item build** (Lane → Early mid →
Mid → Late), split into **Core** (what most players build) and **Situational** (higher win-rate
optional picks), each labelled with the actual numbers behind it so you can learn while you follow it.

It's a pure client-side React app — it calls [deadlock-api.com](https://api.deadlock-api.com) directly
from the browser (CORS is open, no API key, no backend, no compute cost).

## Run

```bash
npm install
npm run dev      # http://localhost:5173
```

## How it works

The heavy statistics are already done server-side. The `item-flow-stats` endpoint returns, per item
per phase, an **`adjusted_win_rate`** — the win rate standardized to the net-worth-at-buy distribution.
That removes the biggest confound in naive win-rate builds ("richer players win more"), which is the
main thing Statlocker's WPA model exists to correct. So this tool doesn't model anything; it just
**ranks and thresholds**:

- `src/api/deadlock.ts` — typed client + asset caching (heroes, items, patches).
- `src/lib/ranks.ts` — rank tiers ↔ `average_badge` filter (Eternus = tier 11).
- `src/lib/buildGenerator.ts` — assembles an **opinionated, budget-bounded build**, not a ranked
  list (see below). Tuning thresholds live at the top of the file.
- `src/lib/counters.ts` — "raw top movers" vs a chosen enemy set (see below).
- `src/lib/archetypes.ts` — splits flex heroes into coherent Gun vs Spirit builds (see below).
- `src/App.tsx` — the UI.

### Skill order

`ability-order-stats` returns full ability-upgrade *orders* (≈16 point investments) with win/loss.
Abilities are resolved from the items asset (`type: "ability"`). We surface the **most common order**
(robust against small-sample win-rate noise — it's the standard build good players run) as a grid: one
row per ability (icon + **max 1st → 4th** label) with numbered pips showing the order points go in. For
flex heroes the order is **conditioned on the build archetype** (gun vs spirit skill differently — and
the spirit order often wins more). Win rate is raw, so it runs high; it's a "follow the standard order"
recommendation, not an adjusted metric.

### Slot economy

A build is a moving ~9–12 item window (9 base + 3 flex slots from Walker kills), not the ~16 raw
purchases the phases sum to — early items get sold or built into bigger ones. So the generator marks
**transient** core items (dimmed, "TEMP" chip, excluded from the standing-slot count):

- **Builds into another pick** — items resolve `component_items` → ids at load, so if a recommended
  item is a component of another recommended item, it's a shared slot ("builds into Opening Rounds").
- **Often sold** — a cheap (T1) item with an early `avg_sell_time_s` is a placeholder ("often sold
  ~13:14"). item-stats has no sell *fraction*, so this is a heuristic on cheap items, not a true rate.

Items are also de-duplicated across phases (kept in their highest-pick phase). The header shows
`N/12 standing slots`. Example: Paradox's 16 raw picks → 10 standing; Victor → 9.

### Archetype split (flex heroes)

Flex heroes (Victor, Vyper, Abrams) have viable Gun *and* Spirit builds; aggregating every player
blends them into a hybrid no one runs (gun lane, spirit late). So we pick the most-played **T3
scaling item** of each damage type as a *signature* and condition the population on it via
`include_item_ids` — players who bought the big weapon item are the gun build; the big spirit item,
the spirit build. Each conditioned response carries its own win rate and match count, so the toggle
shows **which archetype wins and how common it is** (e.g. Spirit Abrams 55.8% vs Gun 50.8%). A hero
counts as flex only when both archetypes sit in a contested 30–80% share band **and the two camps are
distinct** — we also query the "bought both signatures" population, and if its overlap exceeds 40% of
the smaller camp the hero is a *hybrid* (Paradox: ~half of "gun" players also buy the spirit item), so
we show one blended build instead of a misleading split. Mono heroes (Geist ~92% spirit) also show a
single build. Finer labels (Tracklock's "Initiator-Spirit")
would come from community-build *tags*, not match stats — a later effort.

Each hero shows a one-line **build-identity note** (`flex` / `hybrid` / `mono`) so it's clear *why*
there is or isn't a toggle. Per-item "why" text shows **what the item does** — a cleaned effect from
the item asset's `description.desc`, or its headline stat — rather than re-stating the win-rate/pick
numbers already on the row.

### Patch filter and counters

- **Patch filter** — `/v1/patches` maps each patch to a `min_unix_timestamp` window. Defaults to
  *Last 30 days*; picking a patch narrows the window (and a freshly-released patch has little data,
  so the header flags a low match count).
- **Matchups** — `hero-counter-stats` returns the full hero-vs-hero matrix (it ignores hero filters),
  fetched once per rank/patch and filtered to the selected hero. Each enemy's win rate is compared to
  the hero's overall win rate; **Tough** (they counter you) and **Favored** matchups show as clickable
  portrait chips that toggle into the enemy list below, so you see what to build against them in one
  click. Win rate is whole-game presence, not lane-only (`same_lane_filter` is a no-op on this
  endpoint); the lane CS differential is surfaced as a tooltip hint instead.
- **Counters** — enter an enemy lineup and `item-stats` is queried with `enemy_hero_ids`, then
  compared to the same hero+rank's baseline. Items are sorted by **raw win-rate delta** (what "top
  movers" means), with a hard sample floor and a ⚠ flag on thin samples — nothing is silently
  reordered. Note: `item-stats` has no adjusted rate, so counter deltas are raw; the with/without
  delta cancels much of the shared confound but lean on the bigger samples. A naive "what wins vs
  hero X" is dominated by generic strong items, so treat single-hero, large-sample movers as the
  trustworthy signal.

### Why it's a build, not a ranking

A build is a *correlated set under a budget*, so the top-N items judged independently don't compose
into one (the highest-WR items may never be bought together). The generator builds each phase from:

1. **Budget** — each phase's target item count and soul spend are derived from what real players of
   this hero+rank actually do (the "5.6 items / 7.1k souls early" number Statlocker surfaces).
2. **Pick-rate core** — the universal "every-game" core is chosen by pick rate, and items each in
   60–70% of builds necessarily co-occur, so co-occurrence is baked in for free. (An earlier version
   conditioned each phase on the prior build via `locked_item_ids`, but locking 3 exact items matched
   <2% of games and emptied later phases — over-engineering for what pick rate already gives.)
3. **Category-balanced fill** — the phase's item count is split across weapon / vitality / spirit in
   the same proportion real players of this hero invest souls (each candidate's `cost × pick mass`),
   then each category is filled best-first: every-game staples by pick rate, then value picks (best
   adjusted win rate above baseline), then most-bought as a floor so a guaranteed category is never
   empty. This is what keeps **defensive items in the build**: greens are bought reactively, so they
   miss the pick-rate and win-rate gates, and a category-blind fill spent the whole budget on
   weapon/spirit (Vyper lane: 0% vitality before, ~17% after — matching real play). Strong-but-rare
   leftovers become situational swaps.
4. **Buy-order** — items within a phase are sorted by average buy time (`item-stats.avg_buy_time_s`),
   so top-to-bottom reads as buy order.

Each phase shows a **souls bar** of its weapon/vitality/spirit split so the balance reads at a glance.
Each generate is 2 parallel API calls (flow + buy times), ~1s.

### The honest caveat

Win-rate builds (this one and the popular sites) still partly measure *who* buys an item, not the
item itself — good players buy good items. `adjusted_win_rate` shrinks that effect but doesn't erase
it. Treat it as a strong prior, not gospel.

A second, measured residual is **buy-timing**: the adjustment conditions on *absolute* net worth at
buy, which is a lossy proxy for actually being ahead (an offline spike on 3,000 Eternus matches:
net-worth-*difference*+time predicts winning at AUC 0.80, absolute net worth+time only 0.70). Win
probability at the moment of purchase climbs from ~50% for tier-1 buys to ~56% for tier-4 — players
buy expensive items disproportionately when already winning — so late/expensive items' win rates
stay slightly flattered even after adjustment. No aggregate-only correction can remove this (the
same spike showed a poor-man's WPA from absolute net worth *scrambles* the ranking, ρ=0.15 vs the
model's local WPA); a real fix needs match-level timelines, i.e. a backend. The per-item
**comeback / win more** tags are the honest per-pick read on this bias.

## Ideas for next

- **Threat-grouped counters** (optional): group counter movers by what they answer (vs-gun,
  vs-spirit, anti-heal, anti-CC) using item properties, as an alternative lens to the raw list.
- **Lane-only counters** via `same_lane_filter` for a sharper "your lane opponent" signal.
- **Fold counters into the build**: surface a matchup's top movers as extra situational picks in the
  phase their buy time lands in.
- **Publish to an in-game build** via the builds write API (the Statlocker/Tracklock "synced build"
  feature), so it's subscribable in-game.
- **Within-phase buy order** from `item-stats.avg_buy_time_s`.
- **Beam search** instead of greedy, for late phases where the greedy lock thins the sample.

## License

MIT — see [LICENSE](LICENSE). The data and game assets come from
[deadlock-api.com](https://deadlock-api.com) (also MIT). Vibelock is an unofficial, fan-made tool
and is not affiliated with or endorsed by Valve; Deadlock and its assets are trademarks of Valve
Corporation.
