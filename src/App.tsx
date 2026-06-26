import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DependencyList,
  type ReactNode,
  type Ref,
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
  getItemPermutationStats,
  getItems,
  getItemStats,
  getPatches,
  type TimeWindow,
} from './api/deadlock';
import { assembleArchetypes, pickSignatures } from './lib/archetypes';
import {
  classifyWinState,
  phaseTempo,
  rerankBuildForComp,
  SLOT_CAP,
  SLOT_COLORS,
  type PhaseTempo,
} from './lib/buildGenerator';
import { matchCommunityBuilds } from './lib/communityBuilds';
import { computeItemCounters } from './lib/counters';
import { buildSynergyLookup, singleRecordsFromFlow } from './lib/synergy';
import { bestImbueTargets } from './lib/imbue';
import { heroMatchups } from './lib/matchups';
import { RANK_TIERS, rankFloorLabel, tierToMinBadge } from './lib/ranks';
import { bestSkillBuild } from './lib/skills';
import type {
  Ability,
  ArchetypeKey,
  ArchetypeSet,
  BuildItem,
  BuildPhase,
  CommunityBuild,
  CounterMark,
  ItemCounters,
  ItemRef,
  GeneratedBuild,
  Hero,
  HeroBuildStatRow,
  HeroCounterRow,
  ImbueTarget,
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

const REDUCED =
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// Drives a panel's `--settle` (0 = crisp, ~0.9 = fully veiled). While its query is in
// flight the frosted veil eases in, then *trickles* toward a floor on a curve scaled to
// how long that panel took to load last time — so it reads as honest progress toward
// "present". Crucially it never fully clears on the timer alone: only the real
// completion snaps it to 0, so it can't lie that a piece is ready before its data lands.
// Each panel learns its own timing (an EMA), so a slow cold query and a fast cached one
// settle at the rate they actually arrive. Writes the var imperatively (no re-render).
function useSettle<T extends HTMLElement>(loading: boolean) {
  const ref = useRef<T>(null);
  const estMs = useRef(900); // EMA of this panel's load time
  const startedAt = useRef(0);
  const raf = useRef(0);

  useEffect(() => {
    cancelAnimationFrame(raf.current);
    const setVar = (k: string, v: number) => ref.current?.style.setProperty(k, v.toFixed(3));

    if (loading) {
      startedAt.current = performance.now();
      if (REDUCED) {
        setVar('--settle', 0.85); // a calm, unreadable static veil — no animated trickle
        return;
      }
      const tick = () => {
        const t = performance.now() - startedAt.current;
        const rampIn = Math.min(t / 240, 1); // ease the veil in so instant loads barely flash
        const progress = Math.min(t / estMs.current, 1);
        const decay = (1 - progress) ** 2; // 1 → 0 as we approach the expected finish
        // Stays heavy enough to keep the content unreadable the whole time; the trickle is
        // only a gentle "developing" hint, never a slide back to legible.
        setVar('--settle', 0.95 * rampIn * (0.82 + 0.18 * decay));
        raf.current = requestAnimationFrame(tick);
      };
      tick();
    } else if (startedAt.current) {
      const dur = performance.now() - startedAt.current;
      estMs.current = estMs.current * 0.7 + dur * 0.3; // learn the timing for next time
      startedAt.current = 0;
      if (REDUCED) {
        setVar('--settle', 0);
        return;
      }
      // The reveal: blur resolves into focus while a brief purple glow pulses — the
      // "this piece just landed" punch.
      const from = Number(ref.current?.style.getPropertyValue('--settle')) || 0;
      const t0 = performance.now();
      const DUR = 560;
      const tick = () => {
        const k = Math.min((performance.now() - t0) / DUR, 1);
        setVar('--settle', from * (1 - k) ** 3); // ease-out to crisp
        setVar('--flash', k < 0.28 ? k / 0.28 : Math.max(0, 1 - (k - 0.28) / 0.72)); // pulse
        if (k < 1) raf.current = requestAnimationFrame(tick);
        else {
          setVar('--settle', 0);
          setVar('--flash', 0);
        }
      };
      tick();
    }
    return () => cancelAnimationFrame(raf.current);
  }, [loading]);

  return ref;
}

/**
 * Runs an abortable async task whenever `deps` change and reports whether it's in flight — the shared
 * scaffolding behind every data fetch here: abort the previous run on change/unmount, flip a loading
 * flag, and funnel failures to one error sink. Pass `null`/`false` as `run` to stand down (no fetch, not
 * loading) when a precondition isn't met. The task gets the AbortSignal; guard your setState calls with
 * `!signal.aborted` so a superseded fetch can't clobber the current selection.
 *
 * Lifting the fetch bodies out of `useEffect` and into a task argument is also what keeps the
 * set-state-in-effect rule satisfied: their setState calls no longer sit lexically inside an effect. The
 * single remaining in-effect transition is `setLoading(true)` below — and that render is exactly what we
 * want (it shows the panel's veil), so it's deliberately exempted.
 */
function useAsyncTask(
  run: ((signal: AbortSignal) => Promise<void>) | null | false,
  deps: DependencyList,
  onError: (message: string) => void,
): boolean {
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!run) return;
    const ctrl = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: render the loading veil
    setLoading(true);
    run(ctrl.signal)
      .catch((e) => !ctrl.signal.aborted && onError(String(e)))
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    return () => ctrl.abort();
    // deps are forwarded by the caller; exhaustive-deps validates them at the call site (additionalHooks).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return loading && !!run;
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
  const [counters, setCounters] = useState<ItemCounters[] | null>(null);
  const [compEdges, setCompEdges] = useState<Map<number, number> | null>(null);
  const [community, setCommunity] = useState<{
    builds: CommunityBuild[];
    stats: HeroBuildStatRow[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);

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
  const loading = useAsyncTask(
    async (signal) => {
      if (!hero || !items) return;
      setError(null);
      const window = windowFor(patches, patchIdx);
      const flowFor = (includeItemIds?: number[]) =>
        getItemFlowStats({ heroId: hero.id, minBadge, ...window, includeItemIds });

      // Base population + buy times (for buy-order) + item-pair permutation stats, in parallel. The
      // permutation payload is large but overlaps the flow fetches below; a failure is non-fatal (the
      // build just ranks on win rate alone and the synergy panel hides).
      const [base, stats, permRows] = await Promise.all([
        flowFor(),
        getItemStats({ heroId: hero.id, minBadge, ...window }),
        getItemPermutationStats({ heroId: hero.id, minBadge, ...window }).catch(() => null),
      ]);
      const buyTimes = new Map(stats.map((s) => [s.item_id, s.avg_buy_time_s]));
      const sellTimes = new Map(stats.map((s) => [s.item_id, s.avg_sell_time_s]));

      // Pairwise synergy lookup (#5/#6): centered + shrunk interaction between item ids, from the
      // unconditioned pairs + singles. Passed into the generator so discretionary core picks lean toward
      // items that reinforce the build; absent pairs ⇒ the build ranks on win rate alone (unchanged).
      const decided = base.baseline.wins + base.baseline.losses;
      const baseline = decided > 0 ? base.baseline.wins / decided : 0.5;
      const synergyOf = permRows
        ? buildSynergyLookup(permRows, singleRecordsFromFlow(base), baseline)
        : undefined;

      // Condition on each archetype's signature item. The gun/spirit overlap (for the
      // flex/hybrid decision) is read out of the gun flow itself, so no extra query.
      const sig = pickSignatures(base, items);
      const [gun, spirit] = await Promise.all([
        sig.gun ? flowFor([sig.gun]) : Promise.resolve(undefined),
        sig.spirit ? flowFor([sig.spirit]) : Promise.resolve(undefined),
      ]);
      if (signal.aborted) return;

      const set = assembleArchetypes(
        hero,
        rankFloorLabel(tier),
        items,
        buyTimes,
        sellTimes,
        { all: base, gun, spirit },
        sig,
        { synergyOf },
      );
      setArchetypeSet(set);
      setArchKey(set.archetypes[0].key); // best win rate (or "all")
    },
    [hero, items, minBadge, tier, patchIdx, patches],
    setError,
  );

  const activeArchetype =
    archetypeSet?.archetypes.find((a) => a.key === archKey) ?? archetypeSet?.archetypes[0] ?? null;
  const build = activeArchetype?.build ?? null;

  // Compute counters vs the chosen enemies.
  const countersLoading = useAsyncTask(
    async (signal) => {
      if (!hero || !items || enemies.length === 0) {
        setCounters(null);
        setCompEdges(null);
        return;
      }
      const window = windowFor(patches, patchIdx);
      const base = { heroId: hero.id, minBadge, ...window };

      // One query per enemy (not a combined `any-of` query) so each item keeps a per-enemy
      // delta — that's what lets a row carry the portrait of the specific hero it answers.
      const [baseStats, perEnemy] = await Promise.all([
        getItemStats(base),
        Promise.all(
          enemies.map((id) =>
            getItemStats({ ...base, enemyHeroIds: [id] }).then((stats) => ({ enemyHeroId: id, stats })),
          ),
        ),
      ]);
      if (signal.aborted) return;
      const { counters: cs, edgeByItem } = computeItemCounters(baseStats, perEnemy, items);
      setCounters(cs);
      setCompEdges(edgeByItem);
    },
    [hero, items, enemies, minBadge, patchIdx, patches],
    setError,
  );

  // The counter matrix is hero-independent, so fetch once per rank/patch and filter by hero.
  const matrixLoading = useAsyncTask(
    async (signal) => {
      if (!items) return;
      const m = await getHeroCounters({ minBadge, ...windowFor(patches, patchIdx) });
      if (!signal.aborted) setCounterMatrix(m);
    },
    [items, minBadge, patchIdx, patches],
    setError,
  );

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
  const skillLoading = useAsyncTask(
    async (signal) => {
      if (!hero) return;
      const base = { heroId: hero.id, minBadge, ...windowFor(patches, patchIdx) };
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
      if (!signal.aborted) setSkillBuild(build);
    },
    [hero, minBadge, patchIdx, patches, activeSignatureId],
    setError,
  );

  // Community builds + their win rate at this rank/patch. Joined and scored against the
  // generated build in a memo below, so changing the active archetype re-scores without
  // refetching.
  const communityLoading = useAsyncTask(
    async (signal) => {
      if (!hero) return;
      const [builds, stats] = await Promise.all([
        getCommunityBuilds(hero.id),
        getHeroBuildStats({ heroId: hero.id, minBadge, ...windowFor(patches, patchIdx) }),
      ]);
      if (!signal.aborted) setCommunity({ builds, stats });
    },
    [hero, minBadge, patchIdx, patches],
    setError,
  );

  // Items the generated build recommends (core picks across phases) — the set we match
  // community builds against.
  // Compare like-for-like: our core ranks against their core, our situational against
  // theirs (secondary). The full set still drives preview highlighting.
  const ourCoreIds = useMemo(
    () => (build ? [...new Set(build.phases.flatMap((p) => p.core.map((b) => b.item.id)))] : []),
    [build],
  );
  const ourSituationalIds = useMemo(() => {
    if (!build) return [];
    const core = new Set(build.phases.flatMap((p) => p.core.map((b) => b.item.id)));
    return [...new Set(build.phases.flatMap((p) => p.situational.map((b) => b.item.id)))].filter(
      (id) => !core.has(id),
    );
  }, [build]);
  const ourIdSet = useMemo(
    () => new Set([...ourCoreIds, ...ourSituationalIds]),
    [ourCoreIds, ourSituationalIds],
  );
  const ourSplit = useMemo(
    () => ({ coreCount: ourCoreIds.length, situCount: ourSituationalIds.length }),
    [ourCoreIds, ourSituationalIds],
  );

  const communityMatch = useMemo(
    () =>
      community && (ourCoreIds.length || ourSituationalIds.length)
        ? matchCommunityBuilds(community.builds, community.stats, ourCoreIds, ourSituationalIds)
        : null,
    [community, ourCoreIds, ourSituationalIds],
  );

  const toggleEnemy = (id: number) =>
    setEnemies((e) => (e.includes(id) ? e.filter((x) => x !== id) : [...e, id]));

  const patchLabel = patchIdx === null ? 'last 30 days' : patches[patchIdx]?.title;
  const enemyNames = enemies.map((id) => heroes.find((h) => h.id === id)?.name ?? '?').join(', ');
  const enemiesById = useMemo(() => {
    const m = new Map<number, Hero>();
    for (const id of enemies) {
      const h = heroes.find((x) => x.id === id);
      if (h) m.set(id, h);
    }
    return m;
  }, [enemies, heroes]);
  // Counters folded into the build: a per-item lookup to tag build rows that answer this
  // comp (with the specific enemy portraits), plus a per-phase bucket (keyed by the same
  // labels buildGenerator uses) for strong counter picks not already in the build.
  const counterByItem = useMemo(() => {
    const m = new Map<number, ItemCounters>();
    for (const c of counters ?? []) m.set(c.item.id, c);
    return m;
  }, [counters]);
  // The plurality ability each imbue item gets imbued onto, from the hero's community builds —
  // surfaced as a tag on imbue items in the build (the most important choice for those items).
  const imbueByItem = useMemo(
    () =>
      community && abilities
        ? bestImbueTargets(community.builds, abilities, slotOrder)
        : new Map<number, ImbueTarget>(),
    [community, abilities, slotOrder],
  );
  const countersByPhase = useMemo(() => {
    const m = new Map<string, ItemCounters[]>();
    for (const c of counters ?? []) {
      const arr = m.get(c.phaseLabel);
      if (arr) arr.push(c);
      else m.set(c.phaseLabel, [c]);
    }
    return m;
  }, [counters]);
  // With a comp selected, re-rank the build for it: the comp decides which non-staples fill
  // each phase's core slots, the role labels, and the order (category counts + staples held).
  const displayBuild = useMemo(
    () =>
      build && compEdges && items && enemies.length > 0
        ? rerankBuildForComp(build, compEdges, items)
        : build,
    [build, compEdges, items, enemies.length],
  );
  // Every item the build already shows anywhere — a counter pick in this set gets a tag
  // in place rather than a duplicate "add" row (its buy-time phase can differ from where
  // the build files it).
  const buildItemIds = useMemo(
    () =>
      new Set(
        (displayBuild?.phases ?? []).flatMap((p) =>
          [...p.core, ...p.situational].map((b) => b.item.id),
        ),
      ),
    [displayBuild],
  );
  const lowPopulation = build !== null && build.population.matches < 400;
  // Any data in flight — drives the single loading strip under the header. `!items`
  // covers the very first paint, before the assets effect has resolved.
  const busy =
    loading ||
    countersLoading ||
    skillLoading ||
    communityLoading ||
    matrixLoading ||
    (!items && !error);
  // The brand mark's icon is a function of the current selection, so it flips to a new
  // item on each action (hero/rank/patch/build-style/enemy change) and is otherwise still.
  const shuffleSeed = `${heroId}|${tier}|${patchIdx}|${archKey}|${enemies.join(',')}`;

  // Per-piece "developing" veils — each tracks its own query so panels settle as their
  // data actually lands, independently of the single strip in the header. The build wears
  // the veil for its own archetype query *and* for a counters re-rank: picking an enemy
  // re-orders the build in place, so it should visibly develop into the answer too.
  const buildRef = useSettle<HTMLElement>(loading || countersLoading);
  const skillRef = useSettle<HTMLElement>(skillLoading);
  const communityRef = useSettle<HTMLElement>(communityLoading);
  const matrixRef = useSettle<HTMLDivElement>(matrixLoading);

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
          <button
            type="button"
            className="guidebtn"
            onClick={() => setShowGuide(true)}
            title="How these numbers are calculated"
          >
            How it works
          </button>
        </div>
        {busy && <div className="loadstrip" aria-hidden="true" />}
      </header>

      {error && <div className="banner error">⚠ {error}</div>}

      <div className="topflow">
        {abilities && skillBuild ? (
          <SkillOrder
            skill={skillBuild}
            abilities={abilities}
            slotOrder={slotOrder}
            settleRef={skillRef}
          />
        ) : (
          hero && !skillLoading && <SkillEmpty />
        )}

        {build && (
          <div className="meta">
            <strong>{build.hero.name}</strong>
            {archetypeSet?.flex && activeArchetype ? ` · ${activeArchetype.label}` : ''} ·{' '}
            {build.rankLabel} · {patchLabel} · {build.population.matches.toLocaleString()} matches ·
            avg game {Math.round(build.population.avgDurationS / 60)} min ·{' '}
            {(build.population.baselineWinRate * 100).toFixed(0)}% avg WR (rows show ± vs this) ·{' '}
            <span className={(displayBuild ?? build).standingSlots > SLOT_CAP ? 'warn' : undefined}>
              {(displayBuild ?? build).standingSlots}/{SLOT_CAP} standing slots
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

        {communityMatch && (communityMatch.best || communityMatch.aligned) && (
          <section className="community" ref={communityRef}>
            <h2>
              Community check <span className="sub">player builds at {build?.rankLabel}</span>
            </h2>
            <div className="crows">
              {communityMatch.agree && communityMatch.best ? (
                <CommunityRow
                  tag="Top build = closest to ours ✓"
                  rb={communityMatch.best}
                  our={ourSplit}
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
                      our={ourSplit}
                      ourIds={ourIdSet}
                      items={items}
                    />
                  )}
                  {communityMatch.aligned && (
                    <CommunityRow
                      tag="Most like ours"
                      rb={communityMatch.aligned}
                      our={ourSplit}
                      ourIds={ourIdSet}
                      items={items}
                    />
                  )}
                </>
              )}
            </div>
            <p className="hint">
              Hover a build to preview its items; click <code>#id</code> to copy it for the in-game
              search.{' '}
              <button type="button" className="guidelink" onClick={() => setShowGuide(true)}>
                What “% match”, core &amp; flex mean →
              </button>
            </p>
          </section>
        )}
      </div>

      {matchups && (matchups.tough.length > 0 || matchups.favorable.length > 0) && (
        <div className="matchups" ref={matrixRef}>
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
            Click a hero to add it below and see what to build against it.{' '}
            <button type="button" className="guidelink" onClick={() => setShowGuide(true)}>
              How matchup rates work →
            </button>
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
        <p className="counters-note">
          The build below is re-ranked for {enemyNames}: picks that answer the comp rise and carry
          the enemy portrait (hover any row for the per-hero gain); picks that are weak into it are
          flagged <span className="weakcomp">▼</span>.{' '}
          <button type="button" className="guidelink" onClick={() => setShowGuide(true)}>
            How comp re-ranking works →
          </button>
        </p>
      )}

      {((loading && !build) || (!items && !error)) && (
        <LoadingState
          items={items}
          label={items ? `Crunching ${hero?.name ?? 'match'} data…` : 'Loading game assets…'}
        />
      )}

      {displayBuild && (
        <main className="phases" ref={buildRef}>
          {displayBuild.phases.map((phase) => {
            // Strong counter picks that file under this phase but aren't already in the build
            // get mixed into the situational list (capped); ones already shown get a portrait
            // tag in place instead, so nothing is duplicated and the page doesn't sprout
            // separate counter sections.
            const counterAdds = (countersByPhase.get(phase.label) ?? [])
              .filter((c) => !buildItemIds.has(c.item.id))
              .slice(0, COUNTER_ADDS_PER_PHASE);
            return (
              <section className="phase" key={phase.column}>
                <h2>
                  {phase.label} <span className="time">{phase.timeLabel}</span>
                </h2>
                <div className="budget">
                  {phase.itemsBought}/{phase.targetItems} items ·{' '}
                  {Math.round(phase.coreSouls).toLocaleString()} /{' '}
                  {Math.round(phase.soulBudget).toLocaleString()} souls
                </div>
                <CategoryBar split={phase.categorySouls} />

                <PhaseTempoLines
                  tempo={phaseTempo(phase, displayBuild.population.baselineWinRate)}
                />

                <h3 className="grouphdr core">Build</h3>
                {phase.core.length ? (
                  phase.core.map((b) => (
                    <ItemRow
                      key={b.item.id}
                      b={b}
                      items={items}
                      baseline={displayBuild.population.baselineWinRate}
                      counter={counterByItem.get(b.item.id)}
                      enemiesById={enemiesById}
                      imbue={imbueByItem.get(b.item.id)}
                    />
                  ))
                ) : (
                  <p className="empty">No clear staple here.</p>
                )}

                <h3 className="grouphdr situational">Situational swaps</h3>
                {phase.situational.map((b) => (
                  <ItemRow
                    key={b.item.id}
                    b={b}
                    items={items}
                    baseline={displayBuild.population.baselineWinRate}
                    counter={counterByItem.get(b.item.id)}
                    enemiesById={enemiesById}
                    imbue={imbueByItem.get(b.item.id)}
                    muted
                  />
                ))}
                {counterAdds.map((c) => (
                  <CounterAddRow
                    key={c.item.id}
                    c={c}
                    items={items}
                    enemiesById={enemiesById}
                    swapFor={swapTargetFor(phase, c, displayBuild.population.baselineWinRate)}
                  />
                ))}
                {phase.situational.length === 0 && counterAdds.length === 0 && (
                  <p className="empty">—</p>
                )}
              </section>
            );
          })}
          <OvertimeColumn
            build={displayBuild}
            items={items}
            counterByItem={counterByItem}
            enemiesById={enemiesById}
            imbueByItem={imbueByItem}
          />
        </main>
      )}

      <footer className="foot">
        Data:{' '}
        <a href="https://deadlock-api.com" target="_blank" rel="noreferrer">
          deadlock-api.com
        </a>
        .{' '}
        <button type="button" className="guidelink" onClick={() => setShowGuide(true)}>
          Methodology &amp; glossary →
        </button>
      </footer>

      {showGuide && <GuideModal onClose={() => setShowGuide(false)} />}
    </div>
  );
}

/** Static reference pane: how every number on the page is derived, plus a glossary of the
 * tags that show up on rows. Opened from the header button, the inline "learn more" links,
 * and the footer. Closes on backdrop click or Escape. */
function GuideModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    // Freeze the page behind the modal so wheel/touch can't scroll it.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
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
          <button type="button" className="guide-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="guide-body">
          <section>
            <h3>Where the numbers come from</h3>
            <p>
              Every panel is computed live from public match data on{' '}
              <a href="https://deadlock-api.com" target="_blank" rel="noreferrer">
                deadlock-api.com
              </a>
              , filtered to the <strong>rank floor</strong> and <strong>patch</strong> you select
              (or the last 30 days). Nothing here is hand-curated — change a control and the whole
              page recomputes.
            </p>
          </section>

          <section>
            <h3>Two kinds of win rate</h3>
            <p>
              <strong>Adjusted win rate</strong> is corrected for{' '}
              <em>net worth at the moment of purchase</em>, so an item doesn’t look strong just
              because the team that was already winning happened to buy it. Build and item rows use
              adjusted rates, and show the <strong>± gap versus the hero’s average</strong>.
            </p>
            <p>
              <strong>Raw win rate</strong> is the plain win rate with no correction. We fall back to
              it wherever no adjusted figure exists — counter deltas, hero matchups, and whole
              community builds — so in those spots, <strong>lean on the larger samples</strong>.
            </p>
          </section>

          <section>
            <h3>Reading a pick’s two rates together</h3>
            <p>The gap between an item’s raw and adjusted rate tells you when it earns its win:</p>
            <ul>
              <li>
                <span className="statetag comeback">comeback</span> adjusted ≫ raw — it holds up
                even when bought from behind. A safer pick when you’re losing.
              </li>
              <li>
                <span className="statetag winmore">win more</span> raw ≫ adjusted — its win rate
                leans on already being ahead. Strong when snowballing, thin when the game is even.
              </li>
            </ul>
            <p className="fine">A pick is only flagged once the gap clears ~3.5 points either way.</p>
          </section>

          <section>
            <h3>How the build is chosen</h3>
            <p>
              The build isn’t just the top win rates sorted top to bottom — a rarely-built item can show a
              flashy rate by luck. A few corrections keep it honest:
            </p>
            <ul>
              <li>
                <strong>Small samples are pulled toward the hero’s average.</strong> Each win rate is
                dragged toward the hero average by how little data backs it — a pick with thousands of games
                barely moves, one with a few dozen is pulled most of the way. A shiny niche item won’t
                outrank a proven staple on noise.
              </li>
              <li>
                <strong>Picks are ranked cautiously.</strong> Discretionary slots are ordered by the win
                rate we’re fairly sure a pick <em>at least</em> reaches, so something we’re confident about
                beats something that merely <em>might</em> be great.
              </li>
              <li>
                <strong>“Value” means real, not just high.</strong> A pick is only labelled a value pick
                when its edge is big enough to be unlikely from chance at that sample size, not just past a
                fixed cutoff. Counters work the same way: an item is tagged as answering an enemy by the
                edge over that matchup we’re <em>confident</em> it has — shrunk toward no-effect by sample —
                so a thin fluke can’t earn a portrait, but a real, moderate counter isn’t hidden either.
              </li>
              <li>
                <strong>Items that win together.</strong> Beyond each pick on its own, the build leans
                toward items that win <em>together</em> more than their solo rates predict, and away from
                redundant pairs — so it reads as a coherent kit, not a list of individually-good parts.
              </li>
            </ul>
            <p className="fine">
              For the curious: empirical-Bayes shrinkage, lower-confidence-bound ranking, significance gates,
              and a centered pairwise-synergy term.
            </p>
          </section>

          <section>
            <h3>Adjusting for the enemy comp</h3>
            <p>
              Add enemy heroes and the build re-ranks. Picks that answer the comp rise and carry the
              enemy’s portrait — the number is that pick’s raw win-rate gain into that hero — while
              picks that are weak into the comp get a <span className="weakcomp">▼</span> flag.
              Staples and per-category soul balance are preserved.
            </p>
            <p>
              A counter is only marked when its edge over the matchup is large enough to be real at that
              sample, and — because every item is tested against every threat at once — we cap how many
              false marks slip through, so most of what you see is genuine. Counter numbers are raw, so they
              read cleanest one threat at a time.
            </p>
          </section>

          <section>
            <h3>Glossary</h3>
            <dl className="glossary">
              <dt>Adjusted WR</dt>
              <dd>Win rate corrected for net worth at purchase. Used on every build/item row.</dd>

              <dt>Raw WR</dt>
              <dd>Uncorrected win rate. Used for counters, matchups, and whole community builds.</dd>

              <dt>Hero avg</dt>
              <dd>
                The population’s baseline win rate for this hero, rank and patch. Rows show ± versus
                it.
              </dd>

              <dt>pulled to average</dt>
              <dd>
                Small-sample win rates are dragged toward the hero average by how little data backs them, so
                a lucky streak on a rarely-built item can’t top the list. The fewer the games, the harder the
                pull.
              </dd>

              <dt>confidence ranking</dt>
              <dd>
                Discretionary picks are ordered by the win rate we’re fairly sure they <em>at least</em>
                reach — a cautious estimate that builds in sample size — so a proven pick beats a shakier
                high-roller.
              </dd>

              <dt>significant</dt>
              <dd>
                An edge big enough to be unlikely from chance at that sample size. It’s the bar a pick clears
                to be called a value pick or a counter — not just beating a fixed number.
              </dd>

              <dt>synergy</dt>
              <dd>
                Two items that win <em>together</em> more (or less) than their solo rates predict. The build
                favours pairs that reinforce each other and avoids redundant ones; it’s baked into which
                picks fill the discretionary slots, not shown as its own list.
              </dd>

              <dt>
                <span className="statetag comeback">comeback</span>
              </dt>
              <dd>Adjusted ≫ raw — the pick holds up even when you buy it from behind.</dd>

              <dt>
                <span className="statetag winmore">win more</span>
              </dt>
              <dd>Raw ≫ adjusted — the pick’s win rate leans on already being ahead.</dd>

              <dt>% match</dt>
              <dd>
                How much a community build’s core overlaps ours: shared ÷ combined core items
                (Jaccard). Ranks builds “most like ours”, so tightly focused builds rank above
                kitchen-sink ones.
              </dd>

              <dt>core / flex</dt>
              <dd>
                Core = the committed picks; flex = situational ones. “core N/M” counts our core picks
                a community build also runs; “flex N/M” counts our situational picks it also flags
                situational (secondary, not ranked).
              </dd>

              <dt>archetype / signature</dt>
              <dd>
                A build style defined by a signature item (e.g. a gun or spirit core). “all” blends
                every build for the hero together.
              </dd>

              <dt>core by X · rush if ahead / buy later</dt>
              <dd>
                A situational pick that becomes core in a later phase. <em>Rush if ahead</em> — buy it
                early when you’re winning — only when it wins about as much bought this early; if it does
                worse early, it’s tagged <em>buy later</em> instead.
              </dd>

              <dt>
                weak into comp <span className="weakcomp">▼</span>
              </dt>
              <dd>The pick loses win rate against the enemies you’ve selected, and nothing on its row counters them.</dd>

              <dt>thin / low sample</dt>
              <dd>Too few matches to trust — treat the number as noisy.</dd>

              <dt>standing slots</dt>
              <dd>How many of your active-item slots the build uses, against the in-game cap.</dd>
            </dl>
          </section>
        </div>
      </div>
    </div>,
    document.body
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
/** The per-phase tempo lines: one for when you're ahead of the soul pace — pull a later-core pick
 * forward — and one for when you're behind — favor resilient picks over snowbally ones. Renders only the
 * lines that have picks, and nothing at all when there's no signal. */
function PhaseTempoLines({ tempo }: { tempo: PhaseTempo | null }) {
  if (!tempo) return null;
  const { rush, lean, hold } = tempo;
  const chip = (b: BuildItem) => (
    <span
      key={b.item.id}
      className="tchip"
      style={{ borderColor: SLOT_COLORS[b.item.slot] ?? SLOT_COLORS.unknown }}
    >
      {b.item.name}
    </span>
  );
  return (
    <div className="tempo">
      {rush.length > 0 && (
        <div
          className="tline ahead"
          title="Ahead of the soul pace? Pull these later-core picks forward now instead of adding a situational."
        >
          <span className="tlbl">▲ ahead</span>
          <span className="tact">rush</span>
          {rush.map(chip)}
        </div>
      )}
      {(lean.length > 0 || hold.length > 0) && (
        <div
          className="tline behind"
          title="Behind the soul pace? Favor the picks that hold up from behind; the win-more picks need a lead to pay off."
        >
          <span className="tlbl">▼ behind</span>
          {lean.length > 0 && (
            <>
              <span className="tact">favor</span>
              {lean.map(chip)}
            </>
          )}
          {hold.length > 0 && (
            <>
              <span className="tact risky">risky</span>
              {hold.map(chip)}
            </>
          )}
        </div>
      )}
    </div>
  );
}

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
        const exact = (souls / total) * 100;
        const pct = Math.round(exact);
        return (
          <span
            key={slot}
            className="catseg"
            style={{ width: `${exact}%`, background: SLOT_COLORS[slot] }}
            title={`${label}: ${souls.toLocaleString()} souls (${exact.toFixed(1)}%)`}
          >
            {exact >= 8 ? `${pct}%` : ''}
          </span>
        );
      })}
    </div>
  );
}

// The overtime buy-list column — a prioritized "spend your surplus" list for games that drag past
// 30 min with the build already full. Rendered as the natural continuation of the Lane→Late columns,
// but it's not a time slice: it's the T3+ upgrades (ranked by *late-window* win rate) to replace your
// lowest-tier slots with once souls stop being the constraint. Reuses ItemRow so each buy still
// carries its win-rate delta, counter portraits, and imbue/learn-more tags.
function OvertimeColumn({
  build,
  items,
  counterByItem,
  enemiesById,
  imbueByItem,
}: {
  build: GeneratedBuild;
  items: Map<number, Item> | null;
  counterByItem: Map<number, ItemCounters>;
  enemiesById: Map<number, Hero>;
  imbueByItem: Map<number, ImbueTarget>;
}) {
  const buys = build.overtimeBuys;
  if (!buys.length) return null;
  return (
    <section className="phase overtime">
      <h2>
        Overtime buys <span className="time">build full · 30+ min</span>
      </h2>
      <div className="budget">Surplus souls? Replace your lowest-tier slots — best at late, top first.</div>
      <h3 className="grouphdr core">Buy in this order</h3>
      {buys.map((b) => (
        <ItemRow
          key={b.item.id}
          b={b}
          items={items}
          baseline={build.population.baselineWinRate}
          counter={counterByItem.get(b.item.id)}
          enemiesById={enemiesById}
          imbue={imbueByItem.get(b.item.id)}
        />
      ))}
    </section>
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
  settleRef,
}: {
  skill: SkillBuild;
  abilities: Map<number, Ability>;
  slotOrder: number[];
  settleRef?: Ref<HTMLElement>;
}) {
  // Rows in in-game slot order; fall back to upgrade order if slots are unknown.
  const present = new Set(skill.order);
  const rows = (slotOrder.length ? slotOrder : skill.maxPriority).filter((id) => present.has(id));
  const colorOf = (id: number) => ABILITY_COLORS[rows.indexOf(id) % ABILITY_COLORS.length];
  const maxLabel = ['max 1st', 'max 2nd', 'max 3rd', 'max 4th'];

  return (
    <section className="skills" ref={settleRef}>
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

const COUNTER_ADDS_PER_PHASE = 3; // cap on counter-only picks folded into a phase's swaps
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** One compact bubble: a single enemy's portrait + this item's edge vs that enemy. */
function CounterBubble({ mark, hero }: { mark: CounterMark; hero?: Hero }) {
  return (
    <span
      className={`cbubble ${mark.lowSample ? 'low' : ''}`}
      title={`vs ${hero?.name ?? '?'}: +${(mark.delta * 100).toFixed(1)} win rate${mark.lowSample ? ' (thin sample)' : ''}`}
    >
      {hero?.image && <img src={hero.image} alt={hero.name} loading="lazy" />}+
      {(mark.delta * 100).toFixed(1)}
    </span>
  );
}

/** The row's third line: counter bubbles (one per enemy), a weak-vs-comp flag, and any
 * transient note — or, when there's nothing comp-related to say, the item's effect text. */
function ItemTags({
  reason,
  counter,
  enemiesById,
  imbue,
  weakEdge,
  swapFor,
  swapLabel = 'swap for',
  coreLater,
  coreRush,
  rawWr,
  adjWr,
  baseline,
}: {
  reason?: string | null;
  counter?: ItemCounters;
  enemiesById?: Map<number, Hero>;
  /** For an imbue-type item: the ability most authors imbue it onto (a "→ ability" chip). */
  imbue?: ImbueTarget;
  weakEdge?: number;
  swapFor?: ItemRef;
  /** Wording for the swap tag — "swap for" (situational) vs "in for" (drop this for a counter). */
  swapLabel?: string;
  /** Phase label where this situational pick becomes core — shown as a "core by X" tag. */
  coreLater?: string;
  /** Whether rushing it early is supported by its win rate — gates the "rush if ahead" suffix. */
  coreRush?: boolean;
  /** Raw + adjusted win rate; their gap reveals a "win more" (raw≫adj) or "comeback" (adj≫raw) pick. */
  rawWr?: number;
  adjWr?: number;
  /** Hero baseline WR — a win-more/comeback tag only makes sense on a pick that's at least viable. */
  baseline?: number;
}) {
  const bubbles = counter && enemiesById ? counter.marks : [];
  // raw ≫ adj ⇒ the win rate leans on already being ahead ("win more"); adj ≫ raw ⇒ it holds up even when
  // bought behind ("comeback"). Same classifier the per-phase tempo block uses, so the row tag and the
  // tempo lists never disagree about a pick's character.
  const state =
    rawWr !== undefined && adjWr !== undefined && baseline !== undefined
      ? classifyWinState(rawWr, adjWr, baseline)
      : undefined;
  const hasTags =
    !!reason ||
    bubbles.length > 0 ||
    !!imbue ||
    weakEdge !== undefined ||
    !!swapFor ||
    !!coreLater ||
    !!state;
  if (!hasTags) return null;
  return (
    <div className="tags">
      {reason && <span className="reason">{reason}</span>}
      {imbue && (
        <span
          className="rel imbue"
          style={imbue.colorIndex >= 0 ? { borderColor: ABILITY_COLORS[imbue.colorIndex] } : undefined}
          title={`${Math.round(imbue.share * 100)}% of the ${imbue.sample} community builds that set a target imbue this onto ${imbue.ability.name}`}
        >
          {imbue.ability.image && <img src={imbue.ability.image} alt="" loading="lazy" />}
          imbue → {imbue.ability.name}
        </span>
      )}
      {bubbles.map((m) => (
        <CounterBubble key={m.enemyHeroId} mark={m} hero={enemiesById!.get(m.enemyHeroId)} />
      ))}
      {weakEdge !== undefined && (
        <span className="weakcomp" title="Weak into the selected comp">
          ▼ {fmtDelta(weakEdge)}
        </span>
      )}
      {coreLater && (
        <span
          className="rel rush"
          title={
            coreRush
              ? `Core by ${coreLater} — buy early if you're ahead`
              : `Core by ${coreLater} — but it does worse bought this early, so don't rush it`
          }
        >
          core by {coreLater}{coreRush ? ' · rush if ahead' : ' · buy later'}
        </span>
      )}
      {swapFor && (
        <span className="rel swap" title={`${swapLabel} ${swapFor.name}`}>
          {swapLabel} {swapFor.name}
        </span>
      )}
      {state && (
        <span
          className={`statetag ${state}`}
          title={
            state === 'winmore'
              ? `Win-more: raw ${pct(rawWr!)} ≫ adjusted ${pct(adjWr!)} — its win rate leans on already being ahead`
              : `Comeback: adjusted ${pct(adjWr!)} ≫ raw ${pct(rawWr!)} — holds up even when bought behind`
          }
        >
          {state === 'winmore' ? 'win more' : 'comeback'}
        </span>
      )}
    </div>
  );
}

/** A counter pick not already in the build, folded into its phase's swaps list. Headline
 * number is the raw per-enemy delta (item-stats has no adjusted rate). */
/** The core pick a counter item should swap in for: the weakest same-slot core item for this
 * comp (lowest comp-aware score) — the one to drop to make room. */
function swapTargetFor(phase: BuildPhase, c: ItemCounters, baseline: number): ItemRef | undefined {
  // Only a non-staple core pick is a fair thing to drop for an experimental counter.
  const slotCore = phase.core.filter((b) => b.item.slot === c.item.slot && b.role !== 'universal');
  if (!slotCore.length) return undefined;
  const sc = (b: BuildItem) => (b.compEdge ?? 0) + (b.adjustedWinRate - baseline);
  const worst = slotCore.reduce((w, b) => (sc(b) < sc(w) ? b : w));
  return { id: worst.item.id, name: worst.item.name };
}

function CounterAddRow({
  c,
  items,
  enemiesById,
  swapFor,
}: {
  c: ItemCounters;
  items: Map<number, Item> | null;
  enemiesById: Map<number, Hero>;
  /** The core pick to drop to fit this counter in (same slot, weakest for the comp). */
  swapFor?: ItemRef;
}) {
  const color = SLOT_COLORS[c.item.slot] ?? SLOT_COLORS.unknown;
  const top = c.marks[0];
  return (
    <ItemHover
      item={c.item}
      items={items}
      className="item muted counter-add"
      style={{ borderLeftColor: color }}
      counter={c}
      enemiesById={enemiesById}
    >
      <div className="icon" style={{ background: color }}>
        {c.item.image ? <img src={c.item.image} alt="" loading="lazy" /> : null}
      </div>
      <div className="body">
        <div className="line1">
          <span className="name">{c.item.name}</span>
          <span className="cost">{c.item.cost.toLocaleString()}</span>
        </div>
        <div className="line2">
          <span className="wr" style={{ color: deltaColor(top.delta) }}>
            +{(top.delta * 100).toFixed(1)}
            <span className="wrabs">{(top.winRate * 100).toFixed(0)}%</span>
          </span>
          <span className="pick">counters comp</span>
          <span className={`n ${top.lowSample ? 'low' : ''}`}>
            n={top.sample.toLocaleString()}
            {top.lowSample ? ' ⚠' : ''}
          </span>
        </div>
        <ItemTags counter={c} enemiesById={enemiesById} swapFor={swapFor} swapLabel="in for" />
      </div>
    </ItemHover>
  );
}

/** The item's cost. A component-chained upgrade is charged *marginally* — net of components already
 * in the build, which Deadlock refunds into the upgrade — so the rows sum to the phase's soul budget.
 * When that discount applies, show the marginal price with the full sticker struck through. */
function CostTag({ b }: { b: BuildItem }) {
  const eff = b.effectiveCost ?? b.item.cost;
  if (eff >= b.item.cost) return <span className="cost">{b.item.cost.toLocaleString()}</span>;
  const saved = b.item.cost - eff;
  return (
    <span
      className="cost discounted"
      title={`${eff.toLocaleString()} now — ${saved.toLocaleString()} of components already in your build refund into it (full ${b.item.cost.toLocaleString()})`}
    >
      <span className="cost-full">{b.item.cost.toLocaleString()}</span>
      {eff.toLocaleString()}
    </span>
  );
}

function ItemRow({
  b,
  items,
  baseline,
  counter,
  enemiesById,
  imbue,
  muted = false,
}: {
  b: BuildItem;
  items: Map<number, Item> | null;
  /** Hero+rank baseline win rate; item WR is shown as a delta against it. */
  baseline: number;
  /** If this pick also gains win rate vs the selected comp, its per-enemy counter marks. */
  counter?: ItemCounters;
  /** Selected enemies by id, for resolving the counter chip's portraits. */
  enemiesById?: Map<number, Hero>;
  /** For an imbue-type item: the ability most authors imbue it onto. */
  imbue?: ImbueTarget;
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
      counter={counter}
      enemiesById={enemiesById}
      buildsToward={b.buildsToward}
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
          <CostTag b={b} />
        </div>
        <div className="line2">
          <span
            className="wr"
            style={{ color: deltaColor(b.adjustedWinRate - baseline) }}
            title={`${(b.adjustedWinRate * 100).toFixed(1)}% adjusted WR · hero avg ${(baseline * 100).toFixed(1)}%`}
          >
            {fmtDelta(b.adjustedWinRate - baseline)}
            <span className="wrabs">{(b.adjustedWinRate * 100).toFixed(0)}%</span>
          </span>
          <span className="pick">{(b.pickRate * 100).toFixed(0)}% pick</span>
          <span className="n">n={b.sample.toLocaleString()}</span>
        </div>
        <ItemTags
          reason={reason}
          counter={counter}
          enemiesById={enemiesById}
          imbue={imbue}
          weakEdge={!counter && b.weakVsComp ? b.compEdge : undefined}
          swapFor={b.swapFor}
          coreLater={b.coreLater}
          coreRush={b.coreRush}
          rawWr={b.rawWinRate}
          adjWr={b.adjustedWinRate}
          baseline={baseline}
        />
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
  counter,
  enemiesById,
  buildsToward,
}: {
  item: Item;
  items: Map<number, Item> | null;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
  /** When set, the hover card also shows this item's per-enemy counter breakdown. */
  counter?: ItemCounters;
  enemiesById?: Map<number, Hero>;
  /** The item this builds toward (shown as an upgrade-path line in the hover card). */
  buildsToward?: ItemRef;
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
      {anchor && (
        <ItemCard
          item={item}
          items={items}
          anchor={anchor}
          counter={counter}
          enemiesById={enemiesById}
          buildsToward={buildsToward}
        />
      )}
    </div>
  );
}

const CARD_GAP = 10;

function ItemCard({
  item,
  items,
  anchor,
  counter,
  enemiesById,
  buildsToward,
}: {
  item: Item;
  items: Map<number, Item> | null;
  anchor: DOMRect;
  counter?: ItemCounters;
  enemiesById?: Map<number, Hero>;
  buildsToward?: ItemRef;
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

      {counter && enemiesById && counter.marks.length > 0 && (
        <div className="ic-counter">
          <span className="ic-kind">Edge vs this comp</span>
          <ul>
            {counter.marks.map((m) => {
              const h = enemiesById.get(m.enemyHeroId);
              return (
                <li key={m.enemyHeroId}>
                  {h?.image && <img src={h.image} alt="" />}
                  <span className="cn">{h?.name ?? `#${m.enemyHeroId}`}</span>
                  <span className="cd">+{(m.delta * 100).toFixed(1)}</span>
                  <span className="cw">
                    {(m.winRate * 100).toFixed(0)}% WR{m.lowSample ? ' · thin' : ''}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="ic-note">Win-rate gain above the general matchup, vs each enemy.</p>
        </div>
      )}

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
      {buildsToward && (
        <div className="ic-comp">Most build toward: {buildsToward.name}</div>
      )}
    </div>,
    document.body,
  );
}

function CommunityRow({
  tag,
  rb,
  our,
  ourIds,
  items,
  agree = false,
}: {
  tag: string;
  rb: RankedCommunityBuild;
  our: { coreCount: number; situCount: number };
  ourIds: Set<number>;
  items: Map<number, Item> | null;
  agree?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [copied, setCopied] = useState(false);

  const coreSize = rb.build.coreItemIds.length;
  const total = rb.build.itemIds.length;

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
        <span
          className="cmeta"
          title={`Jaccard overlap of our core picks with their core (shared ÷ combined). Ranks “most like ours”; their core is ${coreSize} of ${total} items.`}
        >
          {(rb.similarity * 100).toFixed(0)}% match
        </span>
        <span
          className="cmeta"
          title={
            `${rb.shared} of your ${our.coreCount} core picks are in their ${coreSize}-item core.` +
            (our.situCount > 0
              ? ` Flex: ${rb.situShared} of your ${our.situCount} situational picks appear in their situational list (${total - coreSize} items) — secondary, not ranked.`
              : '')
          }
        >
          core {rb.shared}/{our.coreCount}
          {our.situCount > 0 && ` · flex ${rb.situShared}/${our.situCount}`}
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
  if (role === 'universal') return 'CORE';
  if (role === 'filler') return 'FILLER';
  if (role === 'need') return 'SUSTAIN'; // the only NeedKind we classify
  return 'VALUE';
}

/** Win rate as a signed delta vs the hero baseline (e.g. "+7.2", "−0.7"). */
function fmtDelta(d: number): string {
  const v = d * 100;
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`;
}

/** Color a WR delta: centered on the baseline, so 0 reads neutral, not "bad". */
function deltaColor(d: number): string {
  if (d >= 0.04) return '#54c66b';
  if (d >= 0.02) return '#a6cf57';
  if (d >= -0.02) return '#d8c14a';
  return '#d87a7a';
}
