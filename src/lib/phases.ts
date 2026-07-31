// The build's four phase columns, and the ONE place their time geometry is defined.
//
// The geometry is not ours to choose: item-flow-stats slices purchases into columns of
// `phase_interval_s` seconds, `phase_count` of them, and returns each node's `column`. Whatever we
// print next to a column has to be the window the API actually used, or the label is a fiction.
//
// It was a fiction until 2026-07-30. The API defaults to a 600s interval and we never sent the
// parameter, so the columns were 0–10 / 10–20 / 20–30 / 30+ while the UI labelled the first one
// "0–9 min" and the generator tested sell times against a 540s boundary. Small in effect — only two
// of ~150 items have a mean buy time inside the disputed minute — but the fix is to stop keeping the
// number in three places and instead send it, derive the labels from it, and bucket against it here.
//
// If these are ever retuned, `phase_count` must stay equal to PHASE_LABELS.length: the generator
// indexes columns by position, so a mismatch silently drops or invents a phase.

/** Seconds per flow column. Sent as `phase_interval_s`; never left to the API's default. */
export const FLOW_PHASE_INTERVAL_S = 600;

/** Column names, in column order. Length defines `phase_count`. */
export const PHASE_LABELS = ["Lane", "Early mid", "Mid", "Late"] as const;

/** Number of flow columns. Sent as `phase_count`. */
export const FLOW_PHASE_COUNT = PHASE_LABELS.length;

/** End of each phase's window in seconds; the last is open-ended. Derived, never hand-written. */
export const PHASE_END_S: number[] = PHASE_LABELS.map((_, i) =>
  i === PHASE_LABELS.length - 1
    ? Number.POSITIVE_INFINITY
    : (i + 1) * FLOW_PHASE_INTERVAL_S,
);

const minutes = (s: number) => Math.round(s / 60);

/** Human window for each column, e.g. "0–10 min" … "30+ min". Derived from the same geometry. */
export const PHASE_TIME_LABELS: string[] = PHASE_LABELS.map((_, i) =>
  i === PHASE_LABELS.length - 1
    ? `${minutes(i * FLOW_PHASE_INTERVAL_S)}+ min`
    : `${minutes(i * FLOW_PHASE_INTERVAL_S)}–${minutes((i + 1) * FLOW_PHASE_INTERVAL_S)} min`,
);

/** The column a purchase at `s` seconds falls in, clamped to the last (open-ended) column. */
export function bucketForTime(s: number): number {
  const i = Math.floor(s / FLOW_PHASE_INTERVAL_S);
  return Math.max(0, Math.min(i, PHASE_LABELS.length - 1));
}

/** The phase name a purchase at `s` seconds falls in. */
export function phaseForTime(s: number): string {
  return PHASE_LABELS[bucketForTime(s)];
}
