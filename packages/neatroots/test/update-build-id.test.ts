import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readBuild, staleAfterUpdate } from "../src/util/build.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-test-build-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function bundle(commit: string, version = "0.2.9", built = "2026-10-19T10:00:00.000Z"): string {
  const root = fs.mkdtempSync(path.join(dir, "bundle-"));
  fs.writeFileSync(
    path.join(root, ".neatroots-bundle"),
    `${JSON.stringify({ version, commit, built }, null, 2)}\n`,
  );
  return root;
}

describe("readBuild", () => {
  it("reads the commit a bundle was built from", () => {
    const root = bundle("31dd78e");
    expect(readBuild(root)).toEqual({
      commit: "31dd78e",
      built: "2026-10-19T10:00:00.000Z",
      version: "0.2.9",
    });
  });

  it("is null for a directory that is not a bundle", () => {
    expect(readBuild(dir)).toBeNull();
  });

  it("is null for a bundle file without a commit", () => {
    const root = fs.mkdtempSync(path.join(dir, "no-commit-"));
    fs.writeFileSync(path.join(root, ".neatroots-bundle"), `${JSON.stringify({ version: "0.2.9" })}\n`);
    expect(readBuild(root)).toBeNull();
  });

  it("is null for a bundle file that is not JSON", () => {
    const root = fs.mkdtempSync(path.join(dir, "broken-"));
    fs.writeFileSync(path.join(root, ".neatroots-bundle"), "not json\n");
    expect(readBuild(root)).toBeNull();
  });
});

describe("staleAfterUpdate", () => {
  it("reports a release candidate still running after its release was installed", () => {
    // The case in the issue: v0.2.9-rc.1 and v0.2.9 both say 0.2.9.
    const rc = bundle("a1b2c3d", "0.2.9");
    const release = bundle("e4f5g6h", "0.2.9");
    const stale = staleAfterUpdate(
      { version: "0.2.9", commit: readBuild(rc)?.commit },
      { version: "0.2.9", commit: readBuild(release)?.commit },
    );
    expect(stale).toContain("a1b2c3d");
    expect(stale).toContain("e4f5g6h");
  });

  it("says nothing when the running copy is the one that was installed", () => {
    const same = bundle("a1b2c3d", "0.2.9");
    expect(
      staleAfterUpdate(
        { version: "0.2.9", commit: readBuild(same)?.commit },
        { version: "0.2.9", commit: readBuild(same)?.commit },
      ),
    ).toBeNull();
  });

  it("falls back to the version when no build is known", () => {
    expect(staleAfterUpdate({ version: "0.2.9" }, { version: "0.3.0" })).toContain("0.2.9");
    expect(staleAfterUpdate({ version: "0.2.9" }, { version: "0.2.9" })).toBeNull();
  });

  it("prefers the build over the version", () => {
    // Same version, different build: the build decides, because the version cannot.
    const stale = staleAfterUpdate(
      { version: "0.2.9", commit: "aaaaaaa" },
      { version: "0.2.9", commit: "bbbbbbb" },
    );
    expect(stale).toContain("aaaaaaa");
    expect(stale).toContain("bbbbbbb");
  });
});
