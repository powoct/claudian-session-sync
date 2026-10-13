/**
 * Which of this plugin's features the installed Claudian still supports.
 *
 * Claudian 2.3.3 (upstream #1386) stopped writing the two markers the optional
 * features were built on. Deleting a conversation now removes its record and
 * leaves nothing behind; assigning one to a device is a plain rename. Its own
 * design notes accept the consequence — "rare stale sync conflicts are an
 * accepted tradeoff" — and nothing in Claudian tells the user.
 *
 * Two features were affected, both off by default:
 *
 *  - **Claudian conversation records** (ADR-48) restored any record the sync
 *    folder had and this device did not. Under a markerless Claudian that
 *    brought every deleted conversation back on the next restart. ADR-78
 *    fixed it — a record this device held and no longer holds stays off it —
 *    so there is no warning for it any more.
 *  - **Sharing** (ADR-69/71) moves records into the shared layer, and relied
 *    on the markers to notice a deletion made since. A delete made in the same
 *    Obsidian session as the move can still come back once, and that is not
 *    fixable from files alone; so this one still warns.
 *
 * The default path — admission reading records, the CLI session files
 * themselves — never depended on the markers. Two later Claudian changes do
 * reach it, and are documented rather than warned about here: from 2.3.6 the
 * old `.claude/sessions` folder is no longer read, and from 2.3.11 archiving a
 * Codex conversation moves its session file out of the folder this plugin
 * syncs (OQ-35).
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
  return version !== null && atLeast(version, MARKERLESS_FROM);
}

export interface CompatInput {
  /** Claudian's manifest version, or null when it could not be read. */
  readonly claudianVersion: string | null;
  /** Is "Share this device's conversations" on for this machine? */
  readonly sharing: boolean;
}

export interface CompatWarnings {
  readonly sharing: string | null;
}

/**
 * The sentences to show, per feature, or null where there is nothing to say.
 *
 * Each names the version it read, what goes wrong, and what the user can do
 * about it now. Shown in the settings pane under the feature, and at the top
 * of every sync report while the feature stays on.
 */
export function compatWarnings(input: CompatInput): CompatWarnings {
  if (!isMarkerless(input.claudianVersion)) return { sharing: null };
  const version = input.claudianVersion as string;
  return {
    // The condition is "Claudian's save target for it is still this device's
    // folder", which a user cannot see; these are the two ways it happens.
    sharing: input.sharing
      ? `Claudian ${version} no longer leaves the deletion and assignment markers that ` +
        "sharing relied on. While it is on, a conversation you delete can come back after a " +
        "restart if it was started in this Obsidian session or used shortly before Obsidian " +
        "was last closed; deleting it again removes it. A conversation another device deleted " +
        "or assigned to itself after this device shared it is not shared again — it is listed " +
        'under "Repair shared conversation records" instead. Keep every device on the same ' +
        "Claudian version while sharing is on." +
        (atLeast(version, [2, 3, 12])
          ? " Since Claudian 2.3.12, a conversation in the shared layer cannot be mentioned " +
            "with @ in another conversation."
          : "")
      : null,
  };
}

/** Every sentence that applies, for the sync report. */
export function compatNotices(input: CompatInput): string[] {
  const warnings = compatWarnings(input);
  return [warnings.sharing].filter((warning): warning is string => warning !== null);
}

/**
 * The once-per-launch notice, or null when nothing switched on is affected.
 *
 * Short on purpose: it only has to make someone look. The sentences above are
 * what they find when they do.
 */
export function launchNotice(warnings: CompatWarnings): string | null {
  if (warnings.sharing === null) return null;
  return (
    "Claudian Session Sync: your Claudian version deletes conversations differently, and " +
    "sharing is not fully compatible with it — a conversation deleted in the same session it " +
    "was shared in can come back. Details in this plugin's settings."
  );
}

/** Leading `major.minor.patch` at or above `floor`; false for anything unreadable. */
function atLeast(version: string, floor: readonly [number, number, number]): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  for (let i = 0; i < 3; i += 1) {
    const have = Number(match[i + 1]);
    const need = floor[i] as number;
    if (have !== need) return have > need;
  }
  return true;
}
