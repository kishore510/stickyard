/*
 * Build-time information, gathered by vite.config.ts and injected with `define`.
 * Node-only: the app reads the injected values through src/version.ts and src/about/credits.ts.
 */

/** Short commit SHA, or "dev" when git or the history isn't available. */
export function readCommit(run: (command: string) => string): string {
  try {
    const sha = run("git rev-parse --short HEAD").trim();
    return /^[0-9a-f]{4,40}$/.test(sha) ? sha : "dev";
  } catch {
    return "dev";
  }
}

/** One open-source package, for the credits in About. */
export interface Credit {
  name: string;
  version: string;
  license: string;
}

export interface PackageJson {
  name?: string;
  version?: string;
  license?: unknown;
  dependencies?: Record<string, string>;
}

const creditOf = (name: string, pkg: PackageJson): Credit => ({
  name,
  version: pkg.version ?? "",
  license: typeof pkg.license === "string" ? pkg.license : "See package",
});

/** The named packages (runtime or build tools), with version and licence from their package.json. */
export function creditsFor(names: readonly string[], read: (name: string) => PackageJson | undefined): Credit[] {
  return names.flatMap((name) => {
    const pkg = read(name);
    return pkg ? [creditOf(name, pkg)] : [];
  });
}

/**
 * Everything bundled into the app: the runtime dependencies and what they depend on,
 * read from package metadata. Dev dependencies aren't bundled, so they aren't listed.
 * Workspace packages (`@stickyard/*`) are our own code and are skipped.
 */
export function bundledCredits(root: PackageJson, read: (name: string) => PackageJson | undefined): Credit[] {
  const seen = new Map<string, Credit>();
  const queue = Object.keys(root.dependencies ?? {});
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    if (seen.has(name)) continue;
    const pkg = read(name);
    if (!pkg) continue;
    if (name.startsWith("@stickyard/")) {
      queue.push(...Object.keys(pkg.dependencies ?? {}));
      continue;
    }
    seen.set(name, creditOf(name, pkg));
    queue.push(...Object.keys(pkg.dependencies ?? {}));
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
