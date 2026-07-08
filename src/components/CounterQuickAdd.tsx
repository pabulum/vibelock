// Rapid enemy entry: type a few letters, Enter commits the top fuzzy match and clears the box for
// the next name — "hazENTER vindiENTER…" fills a whole comp without touching the mouse or any
// delimiter. Fuzzy ranking (lib/fuzzy) tolerates as-you-type prefixes and outright typos. Rendered
// alongside the classic dropdown (CounterPicker) so both entry styles stay available.

import { useRef, useState } from "react";
import { rankByFuzzy } from "../lib/fuzzy";
import type { Hero } from "../types";

const MAX_SUGGESTIONS = 6;

export function CounterQuickAdd({
  heroes,
  enemies,
  onAdd,
}: {
  heroes: Hero[];
  enemies: number[];
  onAdd: (id: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const available = heroes.filter((h) => !enemies.includes(h.id));
  const suggestions = query.trim()
    ? rankByFuzzy(query, available, (h) => h.name).slice(0, MAX_SUGGESTIONS)
    : [];

  const commit = (hero: Hero | undefined) => {
    if (!hero) return;
    onAdd(hero.id);
    setQuery(""); // clear for the next name; focus stays on the input
    setHighlight(0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit(suggestions[highlight] ?? suggestions[0]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Escape") {
      setQuery("");
      setHighlight(0);
    }
  };

  return (
    <div className="quickadd">
      <input
        ref={inputRef}
        className="quickadd-in"
        placeholder="enemy + Enter"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
        }}
        onKeyDown={onKeyDown}
        autoComplete="off"
        spellCheck={false}
      />
      {suggestions.length > 0 && (
        <div className="quickadd-menu">
          {suggestions.map((h, i) => (
            <button
              key={h.id}
              type="button"
              className={`quickadd-opt${i === highlight ? " on" : ""}`}
              // mousedown, not click: the input keeps focus (no blur race), so you can keep typing.
              onMouseDown={(e) => {
                e.preventDefault();
                commit(h);
                inputRef.current?.focus();
              }}
              onMouseEnter={() => setHighlight(i)}
            >
              {h.image && <img src={h.image} alt="" loading="lazy" />}
              <span>{h.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
