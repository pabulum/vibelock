// Test-side replacement for the non-null assertion operator. `foo()!` throws a bare
// "cannot read properties of undefined" three lines later, pointing at the wrong thing; this
// throws where the assumption actually broke and names what was missing. Tests only — production
// code should narrow instead (see the guards in features/useBuildData and lib/*).
export function must<T>(value: T | null | undefined, what = "value"): T {
  if (value == null)
    throw new Error(`expected ${what} to be present, got ${value}`);
  return value;
}
