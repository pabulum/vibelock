// Fixture-backed fetch mock for the browser smoke tests. Routes by URL *pathname
// only* — every variant of an analytics query (rank floor, patch window, archetype
// include_item_ids) gets the same captured response, which is exactly right for a
// smoke test: the lib/ suites already cover the statistics; these tests only assert
// that the composed app boots and renders against realistic payloads.
//
// Fixtures are captured (and projected down to the fields the client reads) by
// scripts/capture-fixtures.mjs — rerun it to refresh them after an API change.

import patches from "./fixtures/patches.json";
import heroes from "./fixtures/heroes.json";
import items from "./fixtures/items.json";
import itemStats from "./fixtures/itemStats.json";
import flowStats from "./fixtures/flowStats.json";
import heroBuildStats from "./fixtures/heroBuildStats.json";
import builds from "./fixtures/builds.json";
import permutationStats from "./fixtures/permutationStats.json";
import abilityOrder from "./fixtures/abilityOrder.json";
import counterMatrix from "./fixtures/counterMatrix.json";
import heroLadder from "./fixtures/heroLadder.json";
import wpStats from "./fixtures/wpStats.json";

const routes: Array<[RegExp, unknown]> = [
  [/^\/v2\/patches$/, patches],
  [/^\/v1\/assets\/heroes$/, heroes],
  [/^\/v1\/assets\/items$/, items],
  [/^\/v1\/analytics\/item-stats$/, itemStats],
  [/^\/v1\/analytics\/item-flow-stats$/, flowStats],
  [/^\/v1\/analytics\/hero-build-stats\/\d+$/, heroBuildStats],
  [/^\/v1\/builds$/, builds],
  [/^\/v1\/analytics\/item-permutation-stats$/, permutationStats],
  [/^\/v1\/analytics\/ability-order-stats$/, abilityOrder],
  [/^\/v1\/analytics\/hero-counter-stats$/, counterMatrix],
  [/^\/v1\/analytics\/hero-stats$/, heroLadder],
  [/\/wp-stats\.json$/, wpStats],
];

/**
 * Replaces window.fetch with the fixture router. Same-origin requests (Vitest's own
 * module plumbing) pass through untouched; a cross-origin URL no fixture matches gets
 * a 404 *and* lands in the returned `unmatched` list — assert it's empty so a new
 * endpoint can't silently degrade the page under test.
 */
export function installApiMock(): { unmatched: string[] } {
  const unmatched: string[] = [];
  const realFetch = window.fetch.bind(window);

  // The client caches assets/patches in localStorage; clear so every run exercises
  // the fetch path instead of a previous run's copy.
  localStorage.clear();

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = new URL(href, window.location.href);
    if (url.origin === window.location.origin) return realFetch(input, init);
    for (const [re, data] of routes) {
      if (re.test(url.pathname)) {
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    unmatched.push(url.href);
    return new Response("unmatched by apiMock", { status: 404 });
  };

  return { unmatched };
}
