/**
 * A measured default that has to reach the people already running the plugin.
 *
 * `data.json` cannot tell "the user chose this" from "this was our default and
 * we serialised it", because every field is written on every save. So a
 * correction to a default reaches only fresh installs — which is nobody who
 * matters, since the machines that have been running longest are the ones with
 * the most conversations to lose.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, parseSettings, serialiseSettings } from "../../src/domain/settings";

describe("a superseded default is carried forward once", () => {
  it("moves a stored 3000 to the measured 15000", () => {
    // OQ-16: merging every non-lock file in a Grok session, the whole session
    // held still for 3.3 s in one recorded turn and 8.2 s in another, so 3000
    // reads a mid-turn session as settled. That is a safety value.
    const { settings } = parseSettings({ schemaVersion: 1, localQuietMs: 3_000 });
    expect(settings.localQuietMs).toBe(15_000);
  });

  it("takes a deliberately chosen 3000 too, because the file cannot say it was chosen", () => {
    // The honest half of the trade, asserted rather than glossed. A schema-1
    // file records the same bytes whether the user typed 3000 or the plugin
    // wrote it as its own default, so a promise to keep the first and a
    // promise to correct the second cannot both be kept. This pins which one
    // this project chose — an earlier version of the note claimed both.
    const { settings } = parseSettings({ schemaVersion: 1, localQuietMs: 3_000 });
    expect(settings.localQuietMs).toBe(15_000);
  });

  it("never stamps a newer schema back down to this one", () => {
    // A file a later version wrote is that version's to migrate. Rewriting the
    // number that says so would let a future upgrade run its migrations again
    // over values it had already converted.
    const { settings, unknown } = parseSettings({
      schemaVersion: 99,
      futureMode: true,
      localQuietMs: 9_000,
    });
    expect(settings.schemaVersion).toBe(99);
    expect(serialiseSettings(settings, unknown).schemaVersion).toBe(99);
    expect(unknown.futureMode).toBe(true);
  });

  it("leaves any other stored value exactly alone", () => {
    // Only the old default is carried. Someone who typed a number kept it.
    for (const chosen of [1_000, 2_999, 3_001, 8_000, 60_000]) {
      const { settings } = parseSettings({ schemaVersion: 1, localQuietMs: chosen });
      expect(settings.localQuietMs, `${chosen} was rewritten`).toBe(chosen);
    }
  });

  it("does not touch a file already written by this version", () => {
    // A user on the current schema who has deliberately set 3000 keeps it —
    // by then the value is a choice, because the default it would have been
    // serialised from is 15000.
    const { settings } = parseSettings({
      schemaVersion: DEFAULT_SETTINGS.schemaVersion,
      localQuietMs: 3_000,
    });
    expect(settings.localQuietMs).toBe(3_000);
  });

  it("still gives a fresh install the new default", () => {
    expect(parseSettings({}).settings.localQuietMs).toBe(15_000);
    expect(DEFAULT_SETTINGS.localQuietMs).toBe(15_000);
  });

  it("carries nothing else", () => {
    // The table is one entry on purpose. Rewriting a user's settings is a
    // thing to do once, for a measured reason, not a habit.
    const { settings } = parseSettings({ schemaVersion: 1, remoteQuietMs: 8_000, backupKeep: 3 });
    expect(settings.remoteQuietMs).toBe(8_000);
    expect(settings.backupKeep).toBe(3);
  });
});
