/**
 * Explaining a file the whitelist already rejected (architecture §8.2 layer 2).
 *
 * This is **not** the security boundary and must never be used as one. Layer 1
 * — the adapter's filename whitelist — decides what is a session; everything
 * here does is turn "not a session" into a sentence a user can act on, because
 * "3 files ignored" and "3 Dropbox conflict copies of your sessions" are the
 * same fact with very different next steps.
 *
 * Nothing in this module moves, copies or deletes anything. That restraint is
 * the point of §8.2: moving a misidentified file produces a deletion at its old
 * path, which an external sync tool then propagates to every machine — turning
 * "one machine has a spare file" into "every machine lost one".
 *
 * The confidence column is load-bearing. Syncthing and Dropbox stamp a shape
 * no session id can imitate, so they are named outright. OneDrive's
 * `-<hostname>` suffix is broad enough to match a legitimate id, so it is only
 * ever reported as a *possible* copy and only when a sibling with the stripped
 * name is actually there (§8.2 layer 3).
 */

export type ExternalArtifactKind =
  | "syncthing-conflict-copy"
  | "dropbox-conflict-copy"
  | "copy-suffix"
  | "hostname-suffix"
  | "unknown";

export interface ExternalArtifact {
  readonly kind: ExternalArtifactKind;
  readonly confidence: "high" | "medium" | "low";
  /**
   * The file this appears to be a copy of, as a bare name.
   *
   * Only set when the evidence supports it: a self-identifying pattern (high
   * confidence), or a sibling that the inserted text turns into this name
   * (layer 3). `null` means "we have no idea what this is", which is a fine
   * thing to tell a user and a terrible thing to guess at.
   */
  readonly copyOf: string | null;
}

const UNKNOWN: ExternalArtifact = { kind: "unknown", confidence: "low", copyOf: null };

/** Syncthing: `<stem>.sync-conflict-20260807-120000-ABCDEF.<ext>`. */
const SYNCTHING = /\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]+/;

/**
 * Dropbox, English client: `<stem> (Machine's conflicted copy 2026-08-07).<ext>`.
 *
 * The localised clients say the same thing in another language — the 2026-08-10
 * acceptance run produced Chinese ones — so a second, weaker pattern below
 * matches "parenthesised group containing a date" and settles for medium
 * confidence rather than pretending to read every locale.
 */
const DROPBOX_EN = / \([^()]*conflicted copy \d{4}-\d{2}-\d{2}\)/i;
const DATED_PARENS = / \([^()]*\d{4}-\d{2}-\d{2}\)/;

/** What a sibling-derived insertion may look like, weakest last. */
const INSERTIONS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly kind: ExternalArtifactKind;
  readonly confidence: ExternalArtifact["confidence"];
}> = [
  { pattern: /^\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]+$/, kind: "syncthing-conflict-copy", confidence: "high" },
  { pattern: /^ \([^()]*conflicted copy \d{4}-\d{2}-\d{2}\)$/i, kind: "dropbox-conflict-copy", confidence: "high" },
  { pattern: /^ \([^()]*\d{4}-\d{2}-\d{2}\)$/, kind: "dropbox-conflict-copy", confidence: "medium" },
  { pattern: /^ \(\d+\)$/, kind: "copy-suffix", confidence: "medium" },
  { pattern: /^ - (Copy|副本)( \(\d+\))?$/i, kind: "copy-suffix", confidence: "medium" },
  { pattern: /^-[A-Za-z0-9][A-Za-z0-9._-]*$/, kind: "hostname-suffix", confidence: "low" },
];

/**
 * Classifies a name the whitelist rejected, optionally against its siblings.
 *
 * `siblings` are the other names in the same directory — the layer 3 input. It
 * is optional because layer 3 only *strengthens* a claim: without it the high
 * confidence patterns still self-identify, and the low confidence ones stay
 * `unknown` rather than becoming guesses.
 */
export function classifyExternalArtifact(
  name: string,
  siblings: readonly string[] = [],
): ExternalArtifact {
  const syncthing = SYNCTHING.exec(name);
  if (syncthing) {
    return {
      kind: "syncthing-conflict-copy",
      confidence: "high",
      copyOf: name.slice(0, syncthing.index) + name.slice(syncthing.index + syncthing[0].length),
    };
  }

  const dropbox = DROPBOX_EN.exec(name) ?? DATED_PARENS.exec(name);
  if (dropbox) {
    return {
      kind: "dropbox-conflict-copy",
      confidence: DROPBOX_EN.test(name) ? "high" : "medium",
      copyOf: name.slice(0, dropbox.index) + name.slice(dropbox.index + dropbox[0].length),
    };
  }

  // Layer 3. Whatever text turns a sibling's name into this one is the whole
  // evidence, so the weakest patterns become sayable only here — and only for
  // the sibling that actually exists.
  let best: ExternalArtifact | null = null;
  let bestRank = INSERTIONS.length;
  for (const sibling of siblings) {
    if (sibling === name) continue;
    const inserted = insertionBetween(sibling, name);
    if (inserted === null) continue;
    const rank = INSERTIONS.findIndex((candidate) => candidate.pattern.test(inserted));
    if (rank === -1 || rank >= bestRank) continue;
    const candidate = INSERTIONS[rank] as (typeof INSERTIONS)[number];
    best = { kind: candidate.kind, confidence: candidate.confidence, copyOf: sibling };
    bestRank = rank;
  }
  return best ?? UNKNOWN;
}

/**
 * The text `name` has that `sibling` does not, when `name` is `sibling` with
 * something inserted just before its extension. `null` when it is not.
 *
 * Exported because OQ-18 needs the *relation* without the confidence ladder
 * above it. The only conflict copy ever seen in the field was a Chinese
 * Dropbox client's `… (柴添 的冲突副本 2026-08-29).json`, which misses
 * `DROPBOX_EN` and lands on the medium-confidence dated-parenthesis fallback;
 * and the suite's planted Syncthing name yields `copyOf: null` while being a
 * perfectly good insertion. Gating a data-safety decision on the ladder would
 * therefore have missed the exact case it exists for. This function names
 * candidates; the bytes decide (ADR-57).
 */
export function insertionBetween(sibling: string, name: string): string | null {
  const dot = sibling.lastIndexOf(".");
  const stem = dot <= 0 ? sibling : sibling.slice(0, dot);
  const ext = dot <= 0 ? "" : sibling.slice(dot);
  if (name.length <= sibling.length) return null;
  if (!name.startsWith(stem) || !name.endsWith(ext)) return null;
  return name.slice(stem.length, name.length - ext.length);
}

/** One line for the report, saying what is known and no more. */
export function describeExternalArtifact(artifact: ExternalArtifact): string {
  const source = artifact.copyOf === null ? "" : ` of ${artifact.copyOf}`;
  switch (artifact.kind) {
    case "syncthing-conflict-copy":
      return `Syncthing conflict copy${source} — left where it is, never synced`;
    case "dropbox-conflict-copy":
      return artifact.confidence === "high"
        ? `Dropbox conflict copy${source} — left where it is, never synced`
        : `looks like a conflict copy${source} — left where it is, never synced`;
    case "copy-suffix":
      return `looks like a duplicate${source} — left where it is, never synced`;
    case "hostname-suffix":
      return `possibly a OneDrive copy${source} — left where it is, never synced`;
    default:
      return "not a session file this provider recognises — left where it is, never synced";
  }
}
