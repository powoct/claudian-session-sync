/**
 * The sliver of Electron this plugin uses, declared rather than depended on.
 *
 * `electron` is provided by the Obsidian desktop runtime and is in the build's
 * `external` list, so it is never bundled and there is no package to install
 * types from. Declaring the one member actually called keeps the import
 * specifier a plain literal — the previous `String("electron")` existed only
 * to stop the compiler resolving a module it had no types for, and to a
 * reviewer it read as importing a module chosen at runtime, which is exactly
 * the shape a supply-chain check is looking for.
 *
 * Narrow on purpose: what is not declared here cannot be reached by accident.
 */
declare module "electron" {
  export const shell: {
    /** Resolves to "" on success, or to an error message. */
    openPath(path: string): Promise<string>;
  };
}
