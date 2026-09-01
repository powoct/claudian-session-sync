/**
 * The settings that travel with the vault (architecture §5.6 store (a)).
 *
 * One rule decides what belongs here: **copy this object to another machine
 * running another OS, and it must still be correct.** No absolute path, no
 * machine identifier, no provider root. Those live in the machine-local
 * binding (§5.5), because a Mac's paths landing in a synced file would
 * overwrite the Windows machine's on the next vault sync — silently, and with
 * the plugin then pointed at directories that do not exist.
 *
 * Everything here is also clamped rather than validated-and-rejected. These
 * values arrive from a JSON file another machine wrote, possibly with a newer
 * version of the plugin; refusing to start because one number is out of range
 * would make a settings typo indistinguishable from a broken install.
 */

export const SETTINGS_SCHEMA_VERSION = 2;

/**
 * Values a previous version wrote as *its* default, and this one measured wrong.
 *
 * `data.json` cannot tell "the user chose 3000" from "3000 was our default and
 * we serialised it", because the plugin writes every field on every save. So a
 * measured correction to a default reaches nobody who has already run the
 * plugin — which is every acceptance machine, and every existing user.
 *
 * OQ-16 measured that 3000 ms lets a Grok session that is mid-turn read as
 * settled: merging every non-lock file in the session, the whole thing held
 * still for 3.3 s in one recorded turn and 8.2 s in another. That is a safety
 * value, not a preference, so a stored 3000 is carried to 15000 once — and
 * only from exactly the old default, so anyone who really did pick 3000 by
 * hand and anyone who picked any other number keeps what they picked.
 */
const SUPERSEDED_DEFAULTS: Readonly<Record<string, { readonly was: number; readonly now: number }>> = {
  localQuietMs: { was: 3_000, now: 15_000 },
};

export interface PortableSettings {
  readonly schemaVersion: number;
  /** Minutes between automatic passes; 0 disables them. */
  readonly autoIntervalMinutes: number;
  /** How many backups to keep per file. Never 0 — see §9.3.1. */
  readonly backupKeep: number;
  readonly maxFileSizeMB: number;
  readonly maxFilesPerPass: number;
  readonly localQuietMs: number;
  readonly remoteQuietMs: number;
  readonly clockSkewToleranceMs: number;
  /** Hours before a file is read in full again regardless of the cache (T1). */
  readonly scrubMaxAgeHours: number;
  /**
   * Publish this device's conversations to the flat layer, so the vault's
   * other machines can see them in Claudian (ADR-67). Off by default: it
   * writes into another plugin's store, and the trade it makes is one the
   * user has to opt into knowingly.
   */
  readonly mirrorConversations: boolean;
  readonly logLevel: "off" | "info" | "debug";
}

/**
 * Bounds, and why each one is where it is.
 *
 * `backupKeep` cannot be 0: an invariant a user can switch off is not an
 * invariant, and I1 says every overwritten version stays recoverable (§9.3.1).
 * The quiet windows can be 0 — that produces more aborted writes, not lost
 * data, because the real protections are verified overwrite and backup.
 */
const BOUNDS = {
  autoIntervalMinutes: { min: 0, max: 24 * 60, fallback: 5 },
  backupKeep: { min: 1, max: 20, fallback: 3 },
  // 64, not 20: the 2026-08-13 probe measured a routine Codex rollout at
  // 23 MiB, which the old default silently benched with SKIP_TOO_LARGE. The
  // cap exists to keep a pass from choking on a pathological file, so it
  // wants headroom over the largest *ordinary* one, not a tight fit.
  maxFileSizeMB: { min: 1, max: 512, fallback: 64 },
  maxFilesPerPass: { min: 1, max: 5000, fallback: 200 },
  // 15 s, measured, not chosen (OQ-16). Two 100 ms-resolution samplings of a
  // single Grok turn were re-read for this: merging every non-lock file in the
  // session — which is exactly the composite the group witness of ADR-58
  // watches — the whole session held *entirely* still for 3.3 s in one run and
  // 8.2 s in the other, mid-turn, with the model still emitting. At 3 s the
  // window called that settled twice in one turn. 15 s clears both with room.
  //
  // Not a guarantee, and §9.1.5 already says so: a plateau is as long as the
  // model takes to think, and two runs is two runs. What the number buys is
  // that the *measured* plateaus no longer fit inside it.
  //
  // It costs almost nothing. At the default 5-minute interval the window never
  // binds — the next pass is 300 s later either way. It binds on "Sync now"
  // pressed within 15 s of a turn, and deferring there is the intended answer.
  localQuietMs: { min: 0, max: 600_000, fallback: 15_000 },
  remoteQuietMs: { min: 0, max: 600_000, fallback: 8_000 },
  clockSkewToleranceMs: { min: 0, max: 24 * 60 * 60 * 1000, fallback: 5_000 },
  scrubMaxAgeHours: { min: 1, max: 30 * 24, fallback: 24 },
} as const;

export const DEFAULT_SETTINGS: PortableSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  autoIntervalMinutes: BOUNDS.autoIntervalMinutes.fallback,
  backupKeep: BOUNDS.backupKeep.fallback,
  maxFileSizeMB: BOUNDS.maxFileSizeMB.fallback,
  maxFilesPerPass: BOUNDS.maxFilesPerPass.fallback,
  localQuietMs: BOUNDS.localQuietMs.fallback,
  remoteQuietMs: BOUNDS.remoteQuietMs.fallback,
  clockSkewToleranceMs: BOUNDS.clockSkewToleranceMs.fallback,
  scrubMaxAgeHours: BOUNDS.scrubMaxAgeHours.fallback,
  mirrorConversations: false,
  logLevel: "info",
};

/**
 * Reads whatever was stored, clamping every number into range.
 *
 * A newer `schemaVersion` is *not* rejected. Settings are behaviour knobs, not
 * a description of where data lives (§5.4 draws that line), so the worst case
 * of reading a future file with today's rules is that an unknown field is
 * ignored — and unknown fields are preserved on write-back so the newer
 * machine does not lose them.
 */
export function parseSettings(raw: unknown): {
  readonly settings: PortableSettings;
  readonly unknown: Readonly<Record<string, unknown>>;
} {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { settings: DEFAULT_SETTINGS, unknown: {} };
  }
  const c = raw as Record<string, unknown>;
  const num = (key: keyof typeof BOUNDS) => clamp(c[key], BOUNDS[key]);

  return {
    settings: {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      autoIntervalMinutes: num("autoIntervalMinutes"),
      backupKeep: num("backupKeep"),
      maxFileSizeMB: num("maxFileSizeMB"),
      maxFilesPerPass: num("maxFilesPerPass"),
      localQuietMs: carried("localQuietMs", c),
      remoteQuietMs: num("remoteQuietMs"),
      clockSkewToleranceMs: num("clockSkewToleranceMs"),
      scrubMaxAgeHours: num("scrubMaxAgeHours"),
      mirrorConversations: c.mirrorConversations === true,
      logLevel: c.logLevel === "off" || c.logLevel === "debug" ? c.logLevel : "info",
    },
    unknown: pickUnknown(c),
  };
}

/** Serialises for `data.json`, keeping fields a newer version added. */
export function serialiseSettings(
  settings: PortableSettings,
  unknown: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return { ...unknown, ...settings };
}

/** The bounds, for a settings panel that wants to say why it refused a value. */
export function boundsFor(key: keyof typeof BOUNDS): { min: number; max: number } {
  return { min: BOUNDS[key].min, max: BOUNDS[key].max };
}

/**
 * A bounded number, except where an older schema stored what was then our own
 * default and is now known to be unsafe (see `SUPERSEDED_DEFAULTS`).
 */
function carried(key: keyof typeof BOUNDS, raw: Record<string, unknown>): number {
  const superseded = SUPERSEDED_DEFAULTS[key];
  const stored = raw[key];
  const olderSchema = typeof raw.schemaVersion === "number" && raw.schemaVersion < SETTINGS_SCHEMA_VERSION;
  if (superseded && olderSchema && stored === superseded.was) {
    return clamp(superseded.now, BOUNDS[key]);
  }
  return clamp(stored, BOUNDS[key]);
}

function clamp(value: unknown, bound: { min: number; max: number; fallback: number }): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return bound.fallback;
  return Math.min(Math.max(Math.round(value), bound.min), bound.max);
}

function pickUnknown(source: Record<string, unknown>): Record<string, unknown> {
  const known = new Set(Object.keys(DEFAULT_SETTINGS));
  return Object.fromEntries(Object.entries(source).filter(([key]) => !known.has(key)));
}
