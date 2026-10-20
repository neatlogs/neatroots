import fs from "node:fs";
import path from "node:path";
import { cliPath } from "./install.js";

// Which build a copy of neatroots is.
//
// The version is not enough on its own: a release candidate and its release share the version
// number, because the version names the release series and not the release. So after
// `neatroots update` from v0.2.9-rc.1 to v0.2.9, the version of the copy that was just
// installed and the version of the copy that is still running are the same string, and the
// command had nothing to report — even though the running copy was the release candidate and the
// new one was the release.
//
// The bundle already ships the commit it was built from (.neatroots-bundle, written by
// scripts/package.mjs). That is the identity that tells the two apart.

export interface BuildInfo {
  /** The commit the bundle was built from. */
  commit: string;
  /** When the bundle was built. */
  built: string;
  /** The version the bundle was built as. */
  version: string;
}

/**
 * The bundle root that holds `.neatroots-bundle`: app/neatroots/dist/cli.js → app.
 *
 * Read once and keep it: the install replaces the app directory, so the path of the running
 * script stops existing on disk halfway through an update.
 */
export function bundleRoot(): string {
  return path.resolve(path.dirname(cliPath()), "..", "..");
}

/** The build a bundle directory was built as, or null when it is not a bundle. */
export function readBuild(dir: string): BuildInfo | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, ".neatroots-bundle"), "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const meta = raw as Record<string, unknown>;
  if (typeof meta.commit !== "string" || !meta.commit) return null;
  return {
    commit: meta.commit,
    built: typeof meta.built === "string" ? meta.built : "",
    version: typeof meta.version === "string" ? meta.version : "",
  };
}

/**
 * The build this process is running, read once when the module loads.
 *
 * It has to be read once and kept: `neatroots update` replaces the app directory on disk while
 * the old process keeps running, so a read per request would report the new build for the old
 * code — the exact confusion this is here to remove.
 *
 * Null for a source checkout, which ships no bundle metadata.
 */
export const RUNNING_BUILD: BuildInfo | null = readBuild(bundleRoot());

/** What `neatroots update` should say about the copy that is still running. */
export interface StaleCopy {
  /** The version the running copy reports. */
  version: string;
  /** The commit the running copy was built from, when it is known. */
  commit?: string | null;
}

/**
 * The build the running copy was started from, as far as it can be told.
 *
 * A server that reports its own build is the best source. A server that cannot — one that
 * predates the build reporting, or a source checkout — falls back to the build that was on disk
 * before the install, but only when that build carries the version the server reports. Otherwise
 * the server was started from an older copy and only the version says what is running.
 */
export function runningBuild(
  status: { version: string; build?: { commit: string } | null } | undefined,
  before: BuildInfo | null,
): string {
  const reported = status?.build?.commit ?? "";
  if (reported) return reported;
  if (before && before.version && before.version === (status?.version ?? "")) return before.commit;
  return "";
}

/**
 * Whether the copy that is running is not the copy that was just installed, and what to say
 * about it. Returns null when there is nothing to report.
 *
 * The build is the reliable signal: the version cannot tell a release candidate from its
 * release. The version is only the fallback, for a running copy that does not report a build
 * (a source checkout, or a copy started before this was added).
 */
export function staleAfterUpdate(running: StaleCopy, installed: StaleCopy): string | null {
  const runningCommit = running.commit ?? "";
  const installedCommit = installed.commit ?? "";
  if (runningCommit && installedCommit) {
    if (runningCommit === installedCommit) return null;
    return `neatroots is still running the build ${runningCommit}, the installed copy is ${installedCommit}`;
  }
  if (running.version && installed.version && running.version !== installed.version) {
    return `neatroots ${running.version} is still running, the installed copy is ${installed.version}`;
  }
  return null;
}
