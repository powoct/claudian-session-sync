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
import { DEFAULT_SETTINGS, parseSettings } from "../../src/domain/settings";

describe("a superseded default is carried forward once", () => {
  it("moves a stored 3000 to the measured 15000", () => {
    // OQ-16: merging every non-lock file in a Grok session, the whole session
    // held still for 3.3 s in one recorded turn and 8.2 s in another, so 3000
    // reads a mid-turn session as settled. That is a safety value.
    const { settings } = parseSettings({ schemaVersion: 1, localQuietMs: 3_000 });
    expect(settings.localQuietMs).toBe(15_000);
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
