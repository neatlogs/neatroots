import fs from "node:fs";
import path from "node:path";

// Where this copy of neatroots came from: a prebuilt bundle (~/.neatroots/app), a source checkout
// (install.sh --from-source or a git clone), or neither (a dev run of some other layout).

export function cliPath(): string {
  return fs.realpathSync(process.argv[1] ?? ".");
}

/** The prebuilt bundle root: app/neatroots/dist/cli.js → app. */
export function bundleDir(): string | undefined {
  const dir = path.resolve(path.dirname(cliPath()), "..", "..");
  return fs.existsSync(path.join(dir, ".neatroots-bundle")) && fs.existsSync(path.join(dir, "install.sh")) ? dir : undefined;
}

/** Release tags distinguish an RC from its final release, even at the same version and commit. */
export function bundleBuild(dir: string | undefined): string | null {
  if (!dir) return null;
  try {
    const info = JSON.parse(fs.readFileSync(path.join(dir, ".neatroots-bundle"), "utf8"));
    // Older bundles only recorded the commit.
    for (const id of [info.tag, info.commit]) if (typeof id === "string" && id.trim() && id !== "unknown") return id;
  } catch {
    // Missing or unreadable metadata must not prevent starting or updating neatroots.
  }
  return null;
}

/** The source checkout root: packages/neatroots/dist/cli.js → repo. */
export function sourceDir(): string | undefined {
  const dir = path.resolve(path.dirname(cliPath()), "..", "..", "..");
  return fs.existsSync(path.join(dir, "install.sh")) && fs.existsSync(path.join(dir, "pnpm-workspace.yaml")) ? dir : undefined;
}

export interface InstallInfo {
  mode: "bundle" | "source" | "other";
  root: string | null;
  /** Folders to pip / npm install the steering hooks from. */
  steer_python: string | null;
  steer_ts: string | null;
  /** The runnable examples (examples/README.md lists them). */
  examples: string | null;
}

export function installInfo(): InstallInfo {
  const b = bundleDir();
  if (b) return { mode: "bundle", root: b, steer_python: path.join(b, "steer", "python", "neatroots-steer"), steer_ts: path.join(b, "steer", "ts"), examples: path.join(b, "examples") };
  const s = sourceDir();
  if (s) return { mode: "source", root: s, steer_python: path.join(s, "python", "neatroots-steer"), steer_ts: path.join(s, "packages", "steer-ts"), examples: path.join(s, "examples") };
  return { mode: "other", root: null, steer_python: null, steer_ts: null, examples: null };
}
