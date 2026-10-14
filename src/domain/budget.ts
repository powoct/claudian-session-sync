/**
 * ADR-82's bound on "not this pass" (architecture §12.2, B0).
 *
 * Charging only groups that read makes `maxFilesPerPass` bind only when more
 * of them need reading than it allows — but some need it every pass (a pair
 * in conflict, an equivalent pair left as is), and enough of those ahead in
 * the fixed listing order would turn the rest away for ever. A group turned
 * away `STARVATION_PASSES` passes running may instead come through from an
 * allowance of `STARVED_ALLOWANCE_FILES` files per pass, kept apart from the
 * budget.
 */
export const STARVATION_PASSES = 5;
export const STARVED_ALLOWANCE_FILES = 20;

export interface StarvedCandidate {
  readonly key: string;
  /** Files in the group: what it costs the allowance. */
  readonly files: number;
  /** Passes in a row the budget has turned it away. */
  readonly waited: number;
}

/**
 * The groups the allowance serves this pass, from candidates in listing
 * order: the longest-waiting first, as many as fit — and the longest-waiting
 * one even if it alone does not, by the same floor as the budget's.
 *
 * By need, not by listing order, and that is the bound. A group it serves
 * counts from zero again while the rest keep counting, so every starved group
 * becomes the longest-waiting in turn however many there are. Served in
 * listing order, the same first few took the allowance every time they came
 * due, and past about six allowances' worth of always-reading groups the ones
 * after them waited for ever (review 2026-10-14).
 */
export function servedFromAllowance(candidates: readonly StarvedCandidate[]): Set<string> {
  const starved = candidates
    .map((candidate, index) => ({ ...candidate, index }))
    .filter((candidate) => candidate.files > 0 && candidate.waited >= STARVATION_PASSES)
    .sort((a, b) => b.waited - a.waited || a.index - b.index);
  const chosen = new Set<string>();
  let room = STARVED_ALLOWANCE_FILES;
  for (const candidate of starved) {
    // A larger group further down is passed over rather than ending the
    // scan; it keeps counting, and the pass it comes first it goes alone.
    if (candidate.files > room && chosen.size > 0) continue;
    chosen.add(candidate.key);
    room -= candidate.files;
    if (room <= 0) break;
  }
  return chosen;
}
