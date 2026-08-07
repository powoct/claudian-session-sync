/**
 * Shared domain vocabulary (architecture §9.7.1, §9.7.2).
 *
 * The branded types are the load-bearing part. `FsGateway`'s write methods
 * accept only `SafeAbsolutePath`, so "forgot to validate this path" is a
 * compile error rather than a runtime hole — and a cast that would launder an
 * unvalidated string past that guarantee is banned by lint everywhere except
 * the two modules whose job is to mint them.
 */

declare const brand: unique symbol;

export type Branded<T, B extends string> = T & { readonly [brand]: B };

/** One path segment: charset-checked, not reserved, length-bounded. */
export type SafeSegment = Branded<string, "SafeSegment">;
/** POSIX-separated, relative, no `..`, depth- and length-bounded. */
export type SafeRelativePath = Branded<string, "SafeRelativePath">;
/** Already realpath'd and checked for containment under a known root. */
export type SafeAbsolutePath = Branded<string, "SafeAbsolutePath">;

export type WorkspaceId = Branded<string, "WorkspaceId">;
export type MachineId = Branded<string, "MachineId">;
export type LogicalId = Branded<string, "LogicalId">;

/**
 * architecture §9.7.2. Everything lands in `PassReport.violations[]`.
 * All are file-level skips except ROOT_OVERLAP, which aborts the whole pass:
 * that one means the configuration itself is poisonous.
 */
export type PathViolation =
  | "TRAVERSAL"
  | "ABSOLUTE"
  | "DRIVE_LETTER"
  | "UNC"
  | "BACKSLASH_IN_REL"
  | "NUL_OR_CONTROL"
  | "EMPTY_SEGMENT"
  | "DOT_SEGMENT"
  | "SEGMENT_CHARSET"
  | "RESERVED_NAME"
  | "TRAILING_DOT_OR_SPACE"
  | "SHORTNAME_LIKE"
  | "SEGMENT_TOO_LONG"
  | "PATH_TOO_LONG"
  | "TOO_DEEP"
  | "SYMLINK"
  | "NOT_REGULAR_FILE"
  | "HARDLINK_SUSPECT"
  | "DENYLISTED"
  | "ROOT_OVERLAP"
  | "CASE_COLLISION"
  | "NORMALIZATION_COLLISION";

/**
 * Validation never throws for untrusted input — a rejected path is an ordinary
 * outcome that has to be reported, counted and skipped, not an exception that
 * unwinds a pass halfway through writing.
 */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly violation: PathViolation; readonly detail?: string };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T>(violation: PathViolation, detail?: string): Result<T> {
  // `exactOptionalPropertyTypes` is on: an explicit `detail: undefined` is not
  // the same as an absent key, so the property is only added when present.
  return detail === undefined ? { ok: false, violation } : { ok: false, violation, detail };
}

/**
 * Thrown for programming errors — a caller passing something the type system
 * should have prevented. Never used for untrusted input; that is `Result`.
 */
export class InvalidInputError extends Error {
  override readonly name = "InvalidInputError";

  constructor(message: string) {
    super(message);
  }
}
