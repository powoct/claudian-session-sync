/**
 * Which of this plugin's features the installed Claudian still supports.
 *
 * Claudian 2.3.3 (upstream #1386) stopped writing the two markers the optional
 * features were built on. Deleting a conversation now removes its record and
 * leaves nothing behind; assigning one to a device is a plain rename. Its own
 * design notes accept the consequence — "rare stale sync conflicts are an
 * accepted tradeoff" — and nothing in either plugin tells the user.
 *
 * Two features are affected, both off by default:
 *
 *  - **Claudian conversation records** (ADR-48) restores a record that exists
 *    in the sync folder and not here. It could not tell "deleted here" from
 *    "not yet arrived" before either; the tombstone beside the record is what
 *    kept Claudian from showing it again. Without one, the conversation comes
 *    back after a restart.
 *  - **Sharing** (ADR-69/71) moved records into the shared layer and relied on
 *    the markers to notice a deletion or an assignment made since. Without
 *    them a same-session delete can come back, another device's delete or
 *    assignment can be published again, and "Assign to this device" does not
 *    stick.
 *
 * The default path — admission reading records, the CLI session files
 * themselves — is unaffected: a deleted record simply stops being admitted.
 *
 * Pure: the version arrives as a string (or null when it could not be read),
 * and null is silence. A warning that fires on a guess about which Claudian is
 * installed teaches the user that this plugin's warnings are guesses.
 */

/** The first release that deletes and assigns without leaving a marker. */
export const MARKERLESS_FROM: readonly [number, number, number] = [2, 3, 3];

/**
 * Does this Claudian delete and assign without markers?
 *
 * Compares the leading `major.minor.patch` only, so a pre-release of 2.3.3
 * counts as 2.3.3 — the change is in it. Anything that does not start with
 * three numbers is unknown, and unknown is false.
 */
export function isMarkerless(version: string | null): boolean {
  if (version === null) return false;
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let i = 0; i < 3; i += 1) {
    const have = parts[i] as number;
    const need = MARKERLESS_FROM[i] as number;
    if (have !== need) return have > need;
  }
  return true;
}

export interface CompatInput {
  /** Claudian's manifest version, or null when it could not be read. */
  readonly claudianVersion: string | null;
  /** Is the "Claudian conversation records" provider enabled on this machine? */
  readonly recordsProvider: boolean;
  /** Is "Share this device's conversations" on for this machine? */
  readonly sharing: boolean;
}

export interface CompatWarnings {
  readonly recordsProvider: string | null;
  readonly sharing: string | null;
}

/**
 * The sentences to show, per feature, or null where there is nothing to say.
 *
 * Each names the version it read, what goes wrong, and what the user can do
 * about it now. They are shown in the settings pane under the feature, and at
 * the top of every sync report while the feature stays on.
 */
export function compatWarnings(input: CompatInput): CompatWarnings {
  if (!isMarkerless(input.claudianVersion)) return { recordsProvider: null, sharing: null };
  const version = input.claudianVersion as string;
  return {
    recordsProvider: input.recordsProvider
      ? `Claudian ${version} deletes a conversation without leaving the marker that ` +
        "“Claudian conversation records” relied on. While it is on, a conversation you " +
        "delete on this machine comes back after Obsidian restarts: the next sync restores " +
        "its record from the sync folder. Your other devices keep it either way. Until this " +
        "plugin is updated for it, turn this off unless your vault sync cannot carry " +
        ".claudian/ — and if you keep it on, expect deleted conversations to return."
      : null,
    sharing: input.sharing
      ? `Claudian ${version} no longer leaves the deletion and assignment markers that ` +
        "sharing relied on. While it is on, a conversation you delete in the same Obsidian " +
        "session it was shared in can come back after a restart, and a conversation another " +
        "device has deleted or assigned to itself can be shared again from this one. Nothing " +
        "is lost either way; if a conversation you deleted comes back, deleting it again " +
        "normally removes it."
      : null,
  };
}

/** Every sentence that applies, for the sync report. */
export function compatNotices(input: CompatInput): string[] {
  const warnings = compatWarnings(input);
  return [warnings.recordsProvider, warnings.sharing].filter(
    (warning): warning is string => warning !== null,
  );
}

/**
 * The once-per-launch notice, or null when nothing switched on is affected.
 *
 * Short on purpose: it only has to make someone look. The sentences above are
 * what they find when they do.
 */
export function launchNotice(warnings: CompatWarnings): string | null {
  const affected = [
    warnings.recordsProvider ? "“Claudian conversation records”" : null,
    warnings.sharing ? "sharing" : null,
  ].filter((name): name is string => name !== null);
  if (affected.length === 0) return null;
  return (
    "Claudian Session Sync: your Claudian version deletes conversations differently, and " +
    `${affected.join(" and ")} ${affected.length > 1 ? "are" : "is"} not fully compatible ` +
    "with it yet — a deleted conversation can come back. Details in this plugin's settings."
  );
}
