import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import './App.css';
import {
  getAbilities,
  getAbilityOrder,
  getCommunityBuilds,
  getHeroBuildStats,
  getHeroCounters,
  getHeroes,
  getItemFlowStats,
  getItems,
  getItemStats,
  getPatches,
  type TimeWindow,
} from './api/deadlock';
import { assembleArchetypes, pickSignatures } from './lib/archetypes';
import { SLOT_CAP, SLOT_COLORS } from './lib/buildGenerator';
import { matchCommunityBuilds } from './lib/communityBuilds';
import { computeCounters } from './lib/counters';
import { heroMatchups } from './lib/matchups';
import { RANK_TIERS, rankFloorLabel, tierToMinBadge } from './lib/ranks';
import { bestSkillBuild } from './lib/skills';
import type {
  Ability,
  ArchetypeKey,
  ArchetypeSet,
  BuildItem,
  CommunityBuild,
  CounterItem,
  Hero,
  HeroBuildStatRow,
  HeroCounterRow,
  Matchup,
  Patch,
  Item,
  RankedCommunityBuild,
  SkillBuild,
} from './types';

// Distinct colors for a hero's four abilities.
const ABILITY_COLORS = ['#6fb1ff', '#e0a23c', '#5fc08a', '#cc6db1'];

/** Time window for a chosen patch index (null = last 30 days). Patches are newest-first. */
function windowFor(patches: Patch[], idx: number | null): TimeWindow {
  if (idx === null || !patches[idx]) return {};
  return {
    minUnixTimestamp: patches[idx].ts,
    maxUnixTimestamp: idx > 0 ? patches[idx - 1].ts : undefined,
  };
}

export default function App() {
  const [heroes, setHeroes] = useState<Hero[]>([]);
  const [items, setItems] = useState<Map<number, Item> | null>(null);
  const [patches, setPatches] = useState<Patch[]>([]);
  const [heroId, setHeroId] = useState<number | null>(null);
  const [tier, setTier] = useState<number>(11); // default Eternus
  const [patchIdx, setPatchIdx] = useState<number | null>(null); // null = last 30 days
  const [enemies, setEnemies] = useState<number[]>([]);

  const [archetypeSet, setArchetypeSet] = useState<ArchetypeSet | null>(null);
  const [archKey, setArchKey] = useState<ArchetypeKey>('all');
  const [counterMatrix, setCounterMatrix] = useState<HeroCounterRow[] | null>(null);
  const [abilities, setAbilities] = useState<Map<number, Ability> | null>(null);
  const [skillBuild, setSkillBuild] = useState<SkillBuild | null>(null);
  const [skillLoading, setSkillLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [counters, setCounters] = useState<CounterItem[] | null>(null);
  const [countersLoading, setCountersLoading] = useState(false);
  const [community, setCommunity] = useState<{
    builds: CommunityBuild[];
    stats: HeroBuildStatRow[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load assets once.
  useEffect(() => {
    Promise.all([getHeroes(), getItems(), getPatches(), getAbilities()])
      .then(([h, i, p, a]) => {
        setHeroes(h);
        setItems(i);
        setPatches(p);
        setAbilities(a);
        if (h.length) setHeroId(h[0].id);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const hero = useMemo(() => heroes.find((h) => h.id === heroId) ?? null, [heroes, heroId]);
  const minBadge = tierToMinBadge(tier);

  // Generate builds, split by archetype for flex heroes.
  useEffect(() => {
    if (!hero || !items) return;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);

    const window = windowFor(patches, patchIdx);
    const flowFor = (includeItemIds?: number[]) =>
      getItemFlowStats({ heroId: hero.id, minBadge, ...window, includeItemIds });

    (async () => {
      // Base population + buy times (for buy-order), in parallel.
      const [base, stats] = await Promise.all([
        flowFor(),
        getItemStats({ heroId: hero.id, minBadge, ...window }),
      ]);
      const buyTimes = new Map(stats.map((s) => [s.item_id, s.avg_buy_time_s]));
      const sellTimes = new Map(stats.map((s) => [s.item_id, s.avg_sell_time_s]));

      // Condition on each archetype's signature item. The gun/spirit overlap (for the
      // flex/hybrid decision) is read out of the gun flow itself, so no extra query.
      const sig = pickSignatures(base, items);
      const [gun, spirit] = await Promise.all([
        sig.gun ? flowFor([sig.gun]) : Promise.resolve(undefined),
        sig.spirit ? flowFor([sig.spirit]) : Promise.resolve(undefined),
      ]);
      if (ctrl.signal.aborted) return;

      const set = assembleArchetypes(
        hero,
        rankFloorLabel(tier),
        items,
        buyTimes,
        sellTimes,
        { all: base, gun, spirit },
        sig,
      );
      setArchetypeSet(set);
      setArchKey(set.archetypes[0].key); // best win rate (or "all")
    })()
      .catch((e) => !ctrl.signal.aborted && setError(String(e)))
      .finally(() => !ctrl.signal.aborted && setLoading(false));

    return () => ctrl.abort();
  }, [hero, items, minBadge, tier, patchIdx, patches]);

  const activeArchetype =
    archetypeSet?.archetypes.find((a) => a.key === archKey) ?? archetypeSet?.archetypes[0] ?? null;
  const build = activeArchetype?.build ?? null;

  // Compute counters vs the chosen enemies.
  useEffect(() => {
    if (!hero || !items || enemies.length === 0) {
      setCounters(null);
      return;
    }
    const ctrl = new AbortController();
    setCountersLoading(true);
    const window = windowFor(patches, patchIdx);
    const base = { heroId: hero.id, minBadge, ...window };

    Promise.all([getItemStats(base), getItemStats({ ...base, enemyHeroIds: enemies })])
      .then(([baseStats, vsStats]) => {
        if (!ctrl.signal.aborted) setCounters(computeCounters(baseStats, vsStats, items));
      })
      .catch((e) => !ctrl.signal.aborted && setError(String(e)))
      .finally(() => !ctrl.signal.aborted && setCountersLoading(false));

    return () => ctrl.abort();
  }, [hero, items, enemies, minBadge, patchIdx, patches]);

  // The counter matrix is hero-independent, so fetch once per rank/patch and filter by hero.
  useEffect(() => {
    if (!items) return;
    const ctrl = new AbortController();
    getHeroCounters({ minBadge, ...windowFor(patches, patchIdx) })
      .then((m) => !ctrl.signal.aborted && setCounterMatrix(m))
      .catch((e) => !ctrl.signal.aborted && setError(String(e)));
    return () => ctrl.abort();
  }, [items, minBadge, patchIdx, patches]);

  const matchups = useMemo(
    () => (counterMatrix && hero ? heroMatchups(counterMatrix, hero.id) : null),
    [counterMatrix, hero],
  );

  // The hero's abilities in in-game slot order (signature1→4), as ability ids.
  const slotOrder = useMemo(() => {
    if (!hero || !abilities) return [];
    const byClass = new Map<string, number>();
    for (const a of abilities.values()) byClass.set(a.className, a.id);
    return hero.signatureClasses
      .map((c) => byClass.get(c))
      .filter((id): id is number => id !== undefined);
  }, [hero, abilities]);

  // Skill (ability upgrade) build, conditioned on the active archetype so gun/spirit
  // builds get their own order (they differ — and the spirit order often wins more).
  const activeSignatureId = activeArchetype?.signature?.id;
  useEffect(() => {
    if (!hero) return;
    const ctrl = new AbortController();
    setSkillLoading(true);
    const base = { heroId: hero.id, minBadge, ...windowFor(patches, patchIdx) };

    (async () => {
      // Prefer the order players ran *with* this archetype's signature item — but that
      // slice is narrow, so at a high rank floor on one patch it can come back empty.
      // Fall back to the hero's overall order so we always have something to show.
      const conditioned = await getAbilityOrder({
        ...base,
        includeItemIds: activeSignatureId ? [activeSignatureId] : undefined,
      });
      let build = bestSkillBuild(conditioned);
      if (!build && activeSignatureId) {
        build = bestSkillBuild(await getAbilityOrder(base));
      }
      if (!ctrl.signal.aborted) setSkillBuild(build);
    })()
      .catch((e) => !ctrl.signal.aborted && setError(String(e)))
      .finally(() => !ctrl.signal.aborted && setSkillLoading(false));

    return () => ctrl.abort();
  }, [hero, minBadge, patchIdx, patches, activeSignatureId]);

  // Community builds + their win rate at this rank/patch. Joined and scored against the
  // generated build in a memo below, so changing the active archetype re-scores without
  // refetching.
  useEffect(() => {
    if (!hero) return;
    const ctrl = new AbortController();
    Promise.all([
      getCommunityBuilds(hero.id),
      getHeroBuildStats({ heroId: hero.id, minBadge, ...windowFor(patches, patchIdx) }),
    ])
      .then(([builds, stats]) => !ctrl.signal.aborted && setCommunity({ builds, stats }))
      .catch((e) => !ctrl.signal.aborted && setError(String(e)));
    return () => ctrl.abort();
  }, [hero, minBadge, patchIdx, patches]);

  // Items the generated build recommends (core picks across phases) — the set we match
  // community builds against.
  // Core + situational, deduped: community builds list situational picks too, so
  // comparing only our core would understate the overlap.
  const ourItemIds = useMemo(
    () =>
      build
        ? [
            ...new Set(
              build.phases.flatMap((p) => [...p.core, ...p.situational]).map((b) => b.item.id),
            ),
          ]
        : [],
    [build],
  );
  const ourIdSet = useMemo(() => new Set(ourItemIds), [ourItemIds]);

  const communityMatch = useMemo(
    () =>
      community && ourItemIds.length
        ? matchCommunityBuilds(community.builds, community.stats, ourItemIds)
        : null,
    [community, ourItemIds],
  );

  const toggleEnemy = (id: number) =>
    setEnemies((e) => (e.includes(id) ? e.filter((x) => x !== id) : [...e, id]));

  const patchLabel = patchIdx === null ? 'last 30 days' : patches[patchIdx]?.title;
  const enemyNames = enemies.map((id) => heroes.find((h) => h.id === id)?.name ?? '?').join(', ');
  const lowPopulation = build !== null && build.population.matches < 400;
  // Any data in flight — drives the single loading strip under the header. `!items`
  // covers the very first paint, before the assets effect has resolved.
  const busy = loading || countersLoading || skillLoading || (!items && !error);
  // The brand mark's icon is a function of the current selection, so it flips to a new
  // item on each action (hero/rank/patch/build-style/enemy change) and is otherwise still.
  const shuffleSeed = `${heroId}|${tier}|${patchIdx}|${archKey}|${enemies.join(',')}`;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <ShuffleMark items={items} seed={shuffleSeed} />
          <span className="brandname">Vibelock</span>
          {hero?.tagline && <span className="tagline">{hero.tagline}</span>}
        </div>
        <div className="controls">
          <label>
            Hero
            <select value={heroId ?? ''} onChange={(e) => setHeroId(Number(e.target.value))}>
              {heroes.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Rank floor
            <select value={tier} onChange={(e) => setTier(Number(e.target.value))}>
              {[...RANK_TIERS].reverse().map((t) => (
                <option key={t.tier} value={t.tier}>
                  {rankFloorLabel(t.tier)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Patch
            <select
              value={patchIdx ?? ''}
              onChange={(e) => setPatchIdx(e.target.value === '' ? null : Number(e.target.value))}
            >
              <option value="">Last 30 days</option>
              {patches.map((p, i) => (
                <option key={p.ts} value={i}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
        </div>
        {busy && <div className="loadstrip" aria-hidden="true" />}
      </header>

      {error && <div className="banner error">⚠ {error}</div>}

      {build && (
        <div className="meta">
          <strong>{build.hero.name}</strong>
          {archetypeSet?.flex && activeArchetype ? ` · ${activeArchetype.label}` : ''} ·{' '}
          {build.rankLabel} · {patchLabel} · {build.population.matches.toLocaleString()} matches ·
          avg game {Math.round(build.population.avgDurationS / 60)} min ·{' '}
          <span className={build.standingSlots > SLOT_CAP ? 'warn' : undefined}>
            {build.standingSlots}/{SLOT_CAP} standing slots
          </span>
          {lowPopulation && <span className="warn"> · ⚠ low sample, treat as noisy</span>}
        </div>
      )}

      {archetypeSet?.flex && (
        <div className="archetypes">
          <span className="lbl">Build style</span>
          {archetypeSet.archetypes.map((a) => (
            <button
              key={a.key}
              className={`archtab ${a.key === archKey ? 'active' : ''}`}
              onClick={() => setArchKey(a.key)}
              title={a.signature ? `players who built ${a.signature.name}` : 'every build, blended'}
            >
              <span className="atlabel">{a.label}</span>
              <span className="atmeta">
                {(a.winRate * 100).toFixed(0)}% WR · {(a.share * 100).toFixed(0)}% of games
              </span>
            </button>
          ))}
        </div>
      )}

      {archetypeSet && <div className="identity">{archetypeSet.note}</div>}

      {abilities && skillBuild ? (
        <SkillOrder skill={skillBuild} abilities={abilities} slotOrder={slotOrder} />
      ) : (
        hero && !skillLoading && <SkillEmpty />
      )}

      {communityMatch && (communityMatch.best || communityMatch.aligned) && (
        <section className="community">
          <h2>
            Community check <span className="sub">player builds at {build?.rankLabel}</span>
          </h2>
          <div className="crows">
            {communityMatch.agree && communityMatch.best ? (
              <CommunityRow
                tag="Top build = closest to ours ✓"
                rb={communityMatch.best}
                ourCount={ourItemIds.length}
                ourIds={ourIdSet}
                items={items}
                agree
              />
            ) : (
              <>
                {communityMatch.best && (
                  <CommunityRow
                    tag="Best win rate"
                    rb={communityMatch.best}
                    ourCount={ourItemIds.length}
                    ourIds={ourIdSet}
                    items={items}
                  />
                )}
                {communityMatch.aligned && (
                  <CommunityRow
                    tag="Most like ours"
                    rb={communityMatch.aligned}
                    ourCount={ourItemIds.length}
                    ourIds={ourIdSet}
                    items={items}
                  />
                )}
              </>
            )}
          </div>
          <p className="hint">
            Raw win rate over the selected rank/patch (no adjusted rate exists for whole builds, so
            lean on the larger samples). “shares N” = how many of our build’s picks it also lists;
            hover to preview its items, click <code>#id</code> to copy it for the in-game search.
          </p>
        </section>
      )}

      {matchups && (matchups.tough.length > 0 || matchups.favorable.length > 0) && (
        <div className="matchups">
          {matchups.tough.length > 0 && (
            <div className="mrow">
              <span className="lbl tough">Tough vs</span>
              {matchups.tough.map((m) => (
                <MatchupChip
                  key={m.enemyHeroId}
                  m={m}
                  tough
                  hero={heroes.find((h) => h.id === m.enemyHeroId)}
                  active={enemies.includes(m.enemyHeroId)}
                  onClick={() => toggleEnemy(m.enemyHeroId)}
                />
              ))}
            </div>
          )}
          {matchups.favorable.length > 0 && (
            <div className="mrow">
              <span className="lbl fav">Favored vs</span>
              {matchups.favorable.map((m) => (
                <MatchupChip
                  key={m.enemyHeroId}
                  m={m}
                  hero={heroes.find((h) => h.id === m.enemyHeroId)}
                  active={enemies.includes(m.enemyHeroId)}
                  onClick={() => toggleEnemy(m.enemyHeroId)}
                />
              ))}
            </div>
          )}
          <p className="hint">
            Win rate when this hero is on the enemy team (whole-game, not lane-only). Click one to add
            it below and see what to build against it.
          </p>
        </div>
      )}

      <CounterPicker
        heroes={heroes}
        enemies={enemies}
        onAdd={(id) => setEnemies((e) => (e.includes(id) ? e : [...e, id]))}
        onRemove={(id) => setEnemies((e) => e.filter((x) => x !== id))}
      />

      {enemies.length > 0 && (
        <section className="counters">
          <h2>
            Counters <span className="sub">items that gain win rate vs {enemyNames}</span>
          </h2>
          {counters && counters.length === 0 ? (
            <p className="empty">
              No items clear the sample threshold for this matchup
              {patchIdx !== null ? ' on this patch (try Last 30 days)' : ''}.
            </p>
          ) : (
            <div className="counter-grid">
              {counters?.map((c) => <CounterCard key={c.item.id} c={c} items={items} />)}
            </div>
          )}
          <p className="hint">
            Raw win-rate delta vs your baseline — sorted by gain, thin samples flagged. Tip: one
            threat at a time (e.g. your lane opponent) reads cleaner than the whole enemy team, which
            blends gun and spirit answers together.
          </p>
        </section>
      )}

      {((loading && !build) || (!items && !error)) && (
        <LoadingState
          items={items}
          label={items ? `Crunching ${hero?.name ?? 'match'} data…` : 'Loading game assets…'}
        />
      )}

      {build && (
        <main className="phases">
          {build.phases.map((phase) => (
            <section className="phase" key={phase.column}>
              <h2>
                {phase.label} <span className="time">{phase.timeLabel}</span>
              </h2>
              <div className="budget">
                {phase.core.length}/{phase.targetItems} items ·{' '}
                {Math.round(phase.coreSouls).toLocaleString()} /{' '}
                {Math.round(phase.soulBudget).toLocaleString()} souls
              </div>
              <CategoryBar split={phase.categorySouls} />

              <h3 className="grouphdr core">Build</h3>
              {phase.core.length ? (
                phase.core.map((b) => <ItemRow key={b.item.id} b={b} items={items} />)
              ) : (
                <p className="empty">No clear staple here.</p>
              )}

              <h3 className="grouphdr situational">Situational swaps</h3>
              {phase.situational.length ? (
                phase.situational.map((b) => <ItemRow key={b.item.id} b={b} items={items} muted />)
              ) : (
                <p className="empty">—</p>
              )}
            </section>
          ))}
        </main>
      )}

      <footer className="foot">
        Data: deadlock-api.com · build win rates are <em>adjusted</em> for net-worth-at-buy; counter
        deltas are raw (no adjusted rate available), so lean on the larger samples.
      </footer>
    </div>
  );
}

// The brand mark: a diamond gem that shows a real item icon (masked to the diamond
// silhouette so any source icon reads as one cohesive logo). The icon is derived from
// `seed`, so it changes only when the user takes an action (new hero/rank/patch/style)
// — no timer ticking away. Falls back to a static ◆ until the items asset loads.
// Doubles as the (static, bobbing) spinner in <LoadingState>.
function ShuffleMark({
  items,
  size = 36,
  seed = '',
}: {
  items: Map<number, Item> | null;
  size?: number;
  seed?: string;
}) {
  const pool = useMemo(
    () => (items ? [...items.values()].filter((i) => i.image) : []),
    [items],
  );
  // A per-mount salt so the same selection doesn't always map to the same icon across
  // reloads, while staying stable within a session.
  const salt = useState(() => Math.random().toString(36).slice(2))[0];

  const item = pool.length ? pool[hashIndex(seed + salt, pool.length)] : null;
  return (
    <span className="shufmark" style={{ width: size, height: size }}>
      {item?.image ? (
        <img key={item.id} src={item.image} alt="" />
      ) : (
        <span className="shufmark-fallback">◆</span>
      )}
    </span>
  );
}

/** Stable FNV-1a hash of a string into [0, mod) — used to pick the brand icon. */
function hashIndex(s: string, mod: number): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % mod;
}

// First-paint / cold-query state: the shuffling mark, gently bobbing, over a label.
// Replaces the old "Loading build…" / "refreshing…" text so loading reads as one thing.
function LoadingState({ items, label }: { items: Map<number, Item> | null; label: string }) {
  return (
    <div className="loadstate">
      <ShuffleMark items={items} size={46} />
      <span className="loadlabel">{label}</span>
    </div>
  );
}

// Shown when no skill order clears the sample threshold (high rank + narrow patch). We
// render this instead of nothing so the panel never silently disappears.
function SkillEmpty() {
  return (
    <section className="skills">
      <h2>
        Skill order <span className="sub">not enough games on this filter</span>
      </h2>
      <p className="empty">
        No upgrade order has a confident sample here. Try <strong>Last 30 days</strong> or a lower
        rank floor.
      </p>
    </section>
  );
}

// A thin stacked bar of the souls this phase's build invests per category — the
// "soul investment" split, so a weapon-leaning build that still buys defense reads
// at a glance and the greens aren't lost among the orange/purple.
function CategoryBar({ split }: { split: Record<'weapon' | 'vitality' | 'spirit', number> }) {
  const total = split.weapon + split.vitality + split.spirit;
  if (total <= 0) return null;
  const segs: Array<['weapon' | 'vitality' | 'spirit', string]> = [
    ['weapon', 'Weapon'],
    ['vitality', 'Vitality'],
    ['spirit', 'Spirit'],
  ];
  return (
    <div className="catbar" title="Souls this build invests per category">
      {segs.map(([slot, label]) => {
        const souls = split[slot];
        if (souls <= 0) return null;
        const pct = Math.round((souls / total) * 100);
        return (
          <span
            key={slot}
            className="catseg"
            style={{ width: `${(souls / total) * 100}%`, background: SLOT_COLORS[slot] }}
            title={`${label}: ${souls.toLocaleString()} souls (${pct}%)`}
          >
            {pct >= 12 ? `${pct}%` : ''}
          </span>
        );
      })}
    </div>
  );
}

function CounterPicker({
  heroes,
  enemies,
  onAdd,
  onRemove,
}: {
  heroes: Hero[];
  enemies: number[];
  onAdd: (id: number) => void;
  onRemove: (id: number) => void;
}) {
  return (
    <div className="enemies">
      <span className="lbl">Counters vs</span>
      {enemies.map((id) => {
        const h = heroes.find((x) => x.id === id);
        return (
          <button className="chip" key={id} onClick={() => onRemove(id)} title="remove">
            {h?.name ?? id} ✕
          </button>
        );
      })}
      <select
        value=""
        onChange={(e) => {
          if (e.target.value) onAdd(Number(e.target.value));
        }}
      >
        <option value="">+ add enemy…</option>
        {heroes
          .filter((h) => !enemies.includes(h.id))
          .map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
      </select>
    </div>
  );
}

function SkillOrder({
  skill,
  abilities,
  slotOrder,
}: {
  skill: SkillBuild;
  abilities: Map<number, Ability>;
  slotOrder: number[];
}) {
  // Rows in in-game slot order; fall back to upgrade order if slots are unknown.
  const present = new Set(skill.order);
  const rows = (slotOrder.length ? slotOrder : skill.maxPriority).filter((id) => present.has(id));
  const colorOf = (id: number) => ABILITY_COLORS[rows.indexOf(id) % ABILITY_COLORS.length];
  const maxLabel = ['max 1st', 'max 2nd', 'max 3rd', 'max 4th'];

  return (
    <section className="skills">
      <h2>
        Skill order{' '}
        <span className="sub">
          {(skill.winRate * 100).toFixed(0)}% WR · n={skill.sample.toLocaleString()}
          {skill.lowSample && <span className="warn"> · ⚠ thin sample</span>}
        </span>
      </h2>
      <div className="skill-grid" style={{ ['--steps' as string]: skill.order.length }}>
        {rows.map((id) => {
          const a = abilities.get(id);
          const color = colorOf(id);
          const ri = skill.maxPriority.indexOf(id);
          return (
            <div className="skill-row" key={id}>
              <div className="srow-label" style={{ borderColor: color }}>
                {a?.image && <img src={a.image} alt="" loading="lazy" />}
                <div className="srow-info">
                  <span className="aname">{a?.name ?? id}</span>
                  <span className="amax">{maxLabel[ri] ?? `max ${ri + 1}`}</span>
                </div>
              </div>
              <div className="srow-cells">
                {skill.order.map((stepId, i) => {
                  const on = stepId === id;
                  return (
                    <span
                      key={i}
                      className={`pip ${on ? 'on' : ''}`}
                      style={on ? { background: color } : undefined}
                      title={on ? `point ${i + 1}` : undefined}
                    >
                      {on ? i + 1 : ''}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function MatchupChip({
  m,
  hero,
  active,
  onClick,
  tough = false,
}: {
  m: Matchup;
  hero?: Hero;
  active: boolean;
  onClick: () => void;
  tough?: boolean;
}) {
  return (
    <button
      className={`mchip ${tough ? 'tough' : 'fav'} ${active ? 'active' : ''}`}
      onClick={onClick}
      title={`${hero?.name ?? '?'}: ${(m.winRate * 100).toFixed(0)}% win rate (${m.delta >= 0 ? '+' : ''}${(m.delta * 100).toFixed(0)} vs avg), n=${m.sample.toLocaleString()}${m.laneCsDelta < -10 ? ` · you average ${Math.round(m.laneCsDelta)} CS in lane` : ''}`}
    >
      {hero?.image && <img src={hero.image} alt="" loading="lazy" />}
      <span className="mname">{hero?.name ?? m.enemyHeroId}</span>
      <span className="mwr">{(m.winRate * 100).toFixed(0)}%</span>
      {active && <span className="madd">✓</span>}
    </button>
  );
}

function CounterCard({ c, items }: { c: CounterItem; items: Map<number, Item> | null }) {
  const color = SLOT_COLORS[c.item.slot] ?? SLOT_COLORS.unknown;
  return (
    <ItemHover item={c.item} items={items} className="counter" style={{ borderLeftColor: color }}>
      <div className="icon" style={{ background: color }}>
        {c.item.image ? <img src={c.item.image} alt="" loading="lazy" /> : null}
      </div>
      <div className="body">
        <div className="line1">
          <span className="name">{c.item.name}</span>
          <span className="delta">+{(c.delta * 100).toFixed(1)}</span>
        </div>
        <div className="line2">
          <span className="wr">{(c.winRate * 100).toFixed(0)}% WR</span>
          <span className={`n ${c.lowSample ? 'low' : ''}`}>
            n={c.sample.toLocaleString()}
            {c.lowSample ? ' ⚠' : ''}
          </span>
          <span className="pick">{c.phaseLabel}</span>
        </div>
      </div>
    </ItemHover>
  );
}

function ItemRow({
  b,
  items,
  muted = false,
}: {
  b: BuildItem;
  items: Map<number, Item> | null;
  muted?: boolean;
}) {
  const color = SLOT_COLORS[b.item.slot] ?? SLOT_COLORS.unknown;
  const reason = b.transient && b.transientReason ? b.transientReason : null;
  return (
    <ItemHover
      item={b.item}
      items={items}
      className={`item ${muted ? 'muted' : ''} ${b.transient ? 'transient' : ''}`}
      style={{ borderLeftColor: color }}
    >
      <div className="icon" style={{ background: color }}>
        {b.item.image ? <img src={b.item.image} alt="" loading="lazy" /> : null}
      </div>
      <div className="body">
        <div className="line1">
          <span className="name">
            {!muted && (
              <span className={`role role-${b.transient ? 'temp' : b.role}`}>
                {b.transient ? 'TEMP' : roleLabel(b.role)}
              </span>
            )}
            {b.item.name}
          </span>
          <span className="cost">{b.item.cost.toLocaleString()}</span>
        </div>
        <div className="line2">
          <span className="wr" style={{ color: wrColor(b.adjustedWinRate) }}>
            {(b.adjustedWinRate * 100).toFixed(0)}% WR
          </span>
          <span className="pick">{(b.pickRate * 100).toFixed(0)}% pick</span>
          <span className="n">n={b.sample.toLocaleString()}</span>
        </div>
        <div className="why">{reason ? <span className="reason">{reason}</span> : b.why}</div>
      </div>
    </ItemHover>
  );
}

// A row/cell that reveals the item's full shop card on hover. It *is* the styled
// element (className/style passed through), so there's no extra wrapper. The card is
// rendered in a portal (anchored to this element's rect) so the row can't clip it.
function ItemHover({
  item,
  items,
  className,
  style,
  children,
}: {
  item: Item;
  items: Map<number, Item> | null;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <div
      ref={ref}
      className={className}
      style={style}
      onMouseEnter={() => ref.current && setAnchor(ref.current.getBoundingClientRect())}
      onMouseLeave={() => setAnchor(null)}
    >
      {children}
      {anchor && <ItemCard item={item} items={items} anchor={anchor} />}
    </div>
  );
}

const CARD_GAP = 10;

function ItemCard({
  item,
  items,
  anchor,
}: {
  item: Item;
  items: Map<number, Item> | null;
  anchor: DOMRect;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Render off-screen first, then measure to flip left/right and clamp vertically.
  const [pos, setPos] = useState({ left: -9999, top: -9999 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const left =
      anchor.right + CARD_GAP + w <= window.innerWidth
        ? anchor.right + CARD_GAP
        : Math.max(8, anchor.left - CARD_GAP - w);
    const top = Math.max(8, Math.min(anchor.top, window.innerHeight - 8 - h));
    setPos({ left, top });
  }, [anchor]);

  const color = SLOT_COLORS[item.slot] ?? SLOT_COLORS.unknown;
  const components = item.componentIds
    .map((id) => items?.get(id)?.name)
    .filter((n): n is string => !!n);

  return createPortal(
    <div ref={ref} className="itemcard" style={{ left: pos.left, top: pos.top, borderColor: color }}>
      <div className="ic-head" style={{ background: color }}>
        {item.image && <img src={item.image} alt="" />}
        <div className="ic-title">
          <span className="ic-name">{item.name}</span>
          <span className="ic-sub">
            T{item.tier} · {item.cost.toLocaleString()} souls
          </span>
        </div>
      </div>

      {item.card?.sections.map((s, i) => (
        <div className={`ic-sec ${s.kind}`} key={i}>
          {s.kind !== 'innate' && (
            <span className="ic-kind">{s.kind === 'active' ? 'Active' : 'Passive'}</span>
          )}
          {s.text && s.text.length > 0 && (
            <p className="ic-text">
              {s.text.map((seg, j) =>
                seg.highlight ? <strong key={j}>{seg.text}</strong> : <span key={j}>{seg.text}</span>,
              )}
            </p>
          )}
          {s.stats.length > 0 && (
            <ul className="ic-stats">
              {s.stats.map((st, j) => (
                <li key={j} className={st.strong ? 'strong' : undefined}>
                  <span className="v">{st.value}</span> {st.label}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}

      {!item.card && item.effect && <p className="ic-text plain">{item.effect}</p>}
      {components.length > 0 && (
        <div className="ic-comp">Builds from: {components.join(', ')}</div>
      )}
    </div>,
    document.body,
  );
}

function CommunityRow({
  tag,
  rb,
  ourCount,
  ourIds,
  items,
  agree = false,
}: {
  tag: string;
  rb: RankedCommunityBuild;
  ourCount: number;
  ourIds: Set<number>;
  items: Map<number, Item> | null;
  agree?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [copied, setCopied] = useState(false);

  const copyId = () => {
    navigator.clipboard?.writeText(String(rb.build.id)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }, () => {});
  };

  return (
    <div
      ref={ref}
      className={`crow ${agree ? 'agree' : ''}`}
      onMouseEnter={() => ref.current && setAnchor(ref.current.getBoundingClientRect())}
      onMouseLeave={() => setAnchor(null)}
    >
      <span className="ctag">{tag}</span>
      <span className="cname" title={rb.build.name}>
        {rb.build.name}
      </span>
      <div className="cstats">
        <span className="cwr" style={{ color: wrColor(rb.winRate) }}>
          {(rb.winRate * 100).toFixed(0)}% WR
        </span>
        <span className="cmeta">n={rb.matches.toLocaleString()}</span>
        <span className="cmeta">
          shares {rb.shared}/{ourCount}
        </span>
      </div>
      <div className="cfoot">
        <span className="cmeta">updated {fmtDate(rb.build.updatedAt)}</span>
        <button
          className="cid"
          onClick={copyId}
          title="Copy build ID — paste into the in-game build search"
        >
          {copied ? 'copied ✓' : `#${rb.build.id}`}
        </button>
      </div>
      {anchor && items && (
        <BuildPreview build={rb.build} items={items} ourIds={ourIds} anchor={anchor} />
      )}
    </div>
  );
}

// On-hover preview of a community build's items (slot-colored icons, our shared picks
// highlighted). Portaled + anchored like the item card so the row can't clip it, and
// kept off the default view so the page stays glanceable.
function BuildPreview({
  build,
  items,
  ourIds,
  anchor,
}: {
  build: CommunityBuild;
  items: Map<number, Item>;
  ourIds: Set<number>;
  anchor: DOMRect;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - 8 - w));
    const top =
      anchor.bottom + CARD_GAP + h <= window.innerHeight
        ? anchor.bottom + CARD_GAP
        : Math.max(8, anchor.top - CARD_GAP - h);
    setPos({ left, top });
  }, [anchor]);

  const theirSet = new Set(build.itemIds);
  // Their items, shared-with-ours first so the overlap reads at a glance.
  const resolved = build.itemIds
    .map((id) => items.get(id))
    .filter((i): i is Item => !!i)
    .sort(
      (a, b) =>
        Number(ourIds.has(b.id)) - Number(ourIds.has(a.id)) ||
        a.slot.localeCompare(b.slot) ||
        a.cost - b.cost,
    );
  // Items we recommend that this build doesn't list at all.
  const missing = [...ourIds]
    .filter((id) => !theirSet.has(id))
    .map((id) => items.get(id))
    .filter((i): i is Item => !!i)
    .sort((a, b) => a.slot.localeCompare(b.slot) || a.cost - b.cost);
  const shared = ourIds.size - missing.length;

  const icon = (i: Item, cls: string) => (
    <span
      key={i.id}
      className={`bp-item ${cls}`}
      title={i.name}
      style={{ borderColor: SLOT_COLORS[i.slot] ?? SLOT_COLORS.unknown }}
    >
      {i.image ? <img src={i.image} alt="" loading="lazy" /> : null}
    </span>
  );

  return createPortal(
    <div ref={ref} className="buildprev" style={{ left: pos.left, top: pos.top }}>
      <div className="bp-head">
        <span className="bp-name">{build.name}</span>
        <span className="bp-id">#{build.id}</span>
      </div>
      <div className="bp-grid">{resolved.map((i) => icon(i, ourIds.has(i.id) ? 'shared' : ''))}</div>
      {missing.length > 0 && (
        <>
          <div className="bp-sub">Only in our build ({missing.length})</div>
          <div className="bp-grid">{missing.map((i) => icon(i, 'missing'))}</div>
        </>
      )}
      <div className="bp-foot">
        {shared} of your {ourIds.size} picks shared
        {missing.length > 0 ? ` · ${missing.length} only in ours` : ''}
      </div>
    </div>,
    document.body,
  );
}

function fmtDate(unixS: number): string {
  return unixS ? new Date(unixS * 1000).toISOString().slice(0, 10) : '—';
}

function wrColor(wr: number): string {
  if (wr >= 0.56) return '#54c66b';
  if (wr >= 0.52) return '#a6cf57';
  if (wr >= 0.48) return '#d8c14a';
  return '#d87a7a';
}

function roleLabel(role: BuildItem['role']): string {
  return role === 'universal' ? 'CORE' : 'VALUE';
}
