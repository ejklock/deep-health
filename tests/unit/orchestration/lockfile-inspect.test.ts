import { vi, describe, it, expect, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";
import {
  collectNpmLockfileVersions,
} from "@orchestration/lockfile-inspect";
import { readNpmLockfileVersion } from "@modules/ecosystem/utils/lockfile-utils";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

describe("collectNpmLockfileVersions — lockfileVersion 1 (npm 6)", () => {
  it("extracts top-level dependency versions", () => {
    const lockfile = JSON.stringify({
      name: "sample",
      lockfileVersion: 1,
      dependencies: {
        lodash: { version: "4.17.21", integrity: "sha512-fake" },
        axios: { version: "0.20.0" },
      },
    });

    const map = collectNpmLockfileVersions(lockfile);

    expect(map.get("lodash")).toEqual(new Set(["4.17.21"]));
    expect(map.get("axios")).toEqual(new Set(["0.20.0"]));
  });

  it("recursively walks nested dependencies tree", () => {
    const lockfile = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        "package-a": {
          version: "1.0.0",
          dependencies: {
            "package-b": {
              version: "2.0.0",
              dependencies: {
                "package-c": { version: "3.0.0" },
              },
            },
          },
        },
      },
    });

    const map = collectNpmLockfileVersions(lockfile);

    expect(map.get("package-a")).toEqual(new Set(["1.0.0"]));
    expect(map.get("package-b")).toEqual(new Set(["2.0.0"]));
    expect(map.get("package-c")).toEqual(new Set(["3.0.0"]));
  });

  it("collects multiple versions of the same package across the tree", () => {
    const lockfile = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        "dep-a": {
          version: "1.0.0",
          dependencies: {
            lodash: { version: "4.17.19" },
          },
        },
        "dep-b": {
          version: "1.0.0",
          dependencies: {
            lodash: { version: "4.17.21" },
          },
        },
      },
    });

    const map = collectNpmLockfileVersions(lockfile);

    expect(map.get("lodash")).toEqual(new Set(["4.17.19", "4.17.21"]));
  });
});

describe("collectNpmLockfileVersions — lockfileVersion 2 (npm 7/8)", () => {
  it("extracts packages from both `dependencies` and `packages` trees", () => {
    const lockfile = JSON.stringify({
      name: "sample",
      lockfileVersion: 2,
      dependencies: {
        lodash: { version: "4.17.21" },
      },
      packages: {
        "": { name: "sample", version: "1.0.0" },
        "node_modules/lodash": { version: "4.17.21" },
        "node_modules/axios": { version: "1.6.0" },
      },
    });

    const map = collectNpmLockfileVersions(lockfile);

    expect(map.get("lodash")).toEqual(new Set(["4.17.21"]));
    expect(map.get("axios")).toEqual(new Set(["1.6.0"]));
    // Root package (empty-string key) must be ignored
    expect(map.has("sample")).toBe(false);
  });

  it("handles scoped package path keys", () => {
    const lockfile = JSON.stringify({
      lockfileVersion: 2,
      packages: {
        "": { name: "root", version: "1.0.0" },
        "node_modules/@babel/runtime": { version: "7.26.10" },
        "node_modules/@scope/pkg": { version: "2.0.0" },
      },
    });

    const map = collectNpmLockfileVersions(lockfile);

    expect(map.get("@babel/runtime")).toEqual(new Set(["7.26.10"]));
    expect(map.get("@scope/pkg")).toEqual(new Set(["2.0.0"]));
  });

  it("handles deeply nested node_modules paths (uses trailing segment)", () => {
    const lockfile = JSON.stringify({
      lockfileVersion: 2,
      packages: {
        "node_modules/a/node_modules/b/node_modules/c": { version: "3.3.3" },
      },
    });

    const map = collectNpmLockfileVersions(lockfile);

    expect(map.get("c")).toEqual(new Set(["3.3.3"]));
  });

  it("prefers explicit `name` field over path-derived name", () => {
    const lockfile = JSON.stringify({
      lockfileVersion: 2,
      packages: {
        "node_modules/some-alias": { name: "real-name", version: "1.2.3" },
      },
    });

    const map = collectNpmLockfileVersions(lockfile);

    expect(map.get("real-name")).toEqual(new Set(["1.2.3"]));
    expect(map.has("some-alias")).toBe(false);
  });
});

describe("collectNpmLockfileVersions — lockfileVersion 3 (npm 9+)", () => {
  it("extracts packages when only the `packages` tree is present", () => {
    const lockfile = JSON.stringify({
      name: "sample",
      lockfileVersion: 3,
      packages: {
        "": { name: "sample", version: "1.0.0" },
        "node_modules/lodash": { version: "4.17.21" },
        "node_modules/@babel/runtime": { version: "7.26.10" },
      },
    });

    const map = collectNpmLockfileVersions(lockfile);

    expect(map.get("lodash")).toEqual(new Set(["4.17.21"]));
    expect(map.get("@babel/runtime")).toEqual(new Set(["7.26.10"]));
  });
});

describe("collectNpmLockfileVersions — defensive edge cases", () => {
  it("returns empty map on malformed JSON", () => {
    expect(collectNpmLockfileVersions("NOT JSON").size).toBe(0);
    expect(collectNpmLockfileVersions("").size).toBe(0);
    expect(collectNpmLockfileVersions("{").size).toBe(0);
  });

  it("returns empty map when top-level is not an object", () => {
    expect(collectNpmLockfileVersions('"string"').size).toBe(0);
    expect(collectNpmLockfileVersions("[1,2,3]").size).toBe(0);
    expect(collectNpmLockfileVersions("null").size).toBe(0);
  });

  it("returns empty map when lockfile has no dependencies or packages", () => {
    const lockfile = JSON.stringify({ name: "sample", lockfileVersion: 3 });
    expect(collectNpmLockfileVersions(lockfile).size).toBe(0);
  });

  it("ignores entries without a string version", () => {
    const lockfile = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        "no-version": {},
        "null-version": { version: null },
        "numeric-version": { version: 123 },
        "valid-pkg": { version: "1.0.0" },
      },
    });

    const map = collectNpmLockfileVersions(lockfile);

    expect(map.size).toBe(1);
    expect(map.get("valid-pkg")).toEqual(new Set(["1.0.0"]));
  });

  it("tolerates `packages` entries that lack a derivable name", () => {
    const lockfile = JSON.stringify({
      lockfileVersion: 2,
      packages: {
        "not-a-node-modules-path": { version: "1.0.0" },
        "node_modules/good": { version: "2.0.0" },
      },
    });

    const map = collectNpmLockfileVersions(lockfile);

    expect(map.get("good")).toEqual(new Set(["2.0.0"]));
    expect(map.has("not-a-node-modules-path")).toBe(false);
  });
});

describe("readNpmLockfileVersion", () => {
  const mockedReadFile = readFile as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockedReadFile.mockReset();
  });

  it("returns 1 for a lockfile with lockfileVersion: 1", async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ lockfileVersion: 1, name: "sample" }),
    );
    await expect(readNpmLockfileVersion("/some/path")).resolves.toBe(1);
  });

  it("returns 2 for a lockfile with lockfileVersion: 2", async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ lockfileVersion: 2, name: "sample" }),
    );
    await expect(readNpmLockfileVersion("/some/path")).resolves.toBe(2);
  });

  it("returns 3 for a lockfile with lockfileVersion: 3", async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ lockfileVersion: 3, name: "sample" }),
    );
    await expect(readNpmLockfileVersion("/some/path")).resolves.toBe(3);
  });

  it("returns null when file read throws (ENOENT)", async () => {
    const err = Object.assign(new Error("ENOENT: no such file"), {
      code: "ENOENT",
    });
    mockedReadFile.mockRejectedValue(err);
    await expect(readNpmLockfileVersion("/missing/path")).resolves.toBeNull();
  });

  it("returns null when file is not valid JSON", async () => {
    mockedReadFile.mockResolvedValue("NOT JSON {{{");
    await expect(readNpmLockfileVersion("/some/path")).resolves.toBeNull();
  });

  it("returns null when lockfileVersion field is missing", async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify({ name: "sample" }));
    await expect(readNpmLockfileVersion("/some/path")).resolves.toBeNull();
  });

  it("returns null when lockfileVersion is a string instead of a number", async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify({ lockfileVersion: "1", name: "sample" }),
    );
    await expect(readNpmLockfileVersion("/some/path")).resolves.toBeNull();
  });
});

import {
  collectRootNpmLockfileVersions,
  diffRootNpmLockfileVersions,
} from "@orchestration/lockfile-inspect";

describe("collectRootNpmLockfileVersions — v1 lockfile (lines 149-160)", () => {
  it("returns versions from dependencies object when no packages key", () => {
    const content = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        lodash: { version: "4.17.21" },
        axios: { version: "0.21.0" },
      },
    });
    const map = collectRootNpmLockfileVersions(content);
    expect(map.get("lodash")).toBe("4.17.21");
    expect(map.get("axios")).toBe("0.21.0");
  });

  it("skips entries where version is not a string", () => {
    const content = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        lodash: { version: "4.17.21" },
        broken: { version: 123 },
        missing: {},
      },
    });
    const map = collectRootNpmLockfileVersions(content);
    expect(map.get("lodash")).toBe("4.17.21");
    expect(map.has("broken")).toBe(false);
    expect(map.has("missing")).toBe(false);
  });

  it("returns empty map when dependencies is not an object", () => {
    const content = JSON.stringify({ lockfileVersion: 1, dependencies: null });
    expect(collectRootNpmLockfileVersions(content).size).toBe(0);
  });

  it("returns empty map for invalid JSON", () => {
    expect(collectRootNpmLockfileVersions("NOT JSON").size).toBe(0);
  });

  it("v2: skips non-object package entry (line 128 true branch)", () => {
    const content = JSON.stringify({
      lockfileVersion: 2,
      packages: {
        "node_modules/lodash": { version: "4.17.21" },
        "node_modules/broken": null, // non-object → skip
      },
    });
    const map = collectRootNpmLockfileVersions(content);
    expect(map.get("lodash")).toBe("4.17.21");
    expect(map.has("broken")).toBe(false);
  });

  it("v2: skips entry with non-string version (line 130 true branch)", () => {
    const content = JSON.stringify({
      lockfileVersion: 2,
      packages: {
        "node_modules/lodash": { version: "4.17.21" },
        "node_modules/bad-version": { version: 42 }, // number → skip
      },
    });
    const map = collectRootNpmLockfileVersions(content);
    expect(map.get("lodash")).toBe("4.17.21");
    expect(map.has("bad-version")).toBe(false);
  });

  it("v2: skips nested node_modules path (line 135 true branch)", () => {
    const content = JSON.stringify({
      lockfileVersion: 2,
      packages: {
        "node_modules/lodash": { version: "4.17.21" },
        "node_modules/a/node_modules/nested": { version: "1.0.0" }, // nested → skip
      },
    });
    const map = collectRootNpmLockfileVersions(content);
    expect(map.get("lodash")).toBe("4.17.21");
    expect(map.has("nested")).toBe(false);
    expect(map.has("a/node_modules/nested")).toBe(false);
  });
});

describe("diffRootNpmLockfileVersions (lines 169-186)", () => {
  it("returns changed packages between two v2 lockfiles", () => {
    const before = JSON.stringify({
      lockfileVersion: 2,
      packages: {
        "node_modules/lodash": { version: "4.17.20" },
        "node_modules/axios": { version: "0.21.0" },
      },
    });
    const after = JSON.stringify({
      lockfileVersion: 2,
      packages: {
        "node_modules/lodash": { version: "4.17.21" },
        "node_modules/axios": { version: "0.21.0" },
      },
    });
    const diff = diffRootNpmLockfileVersions(before, after);
    expect(diff.get("lodash")).toEqual({ before: "4.17.20", after: "4.17.21" });
    expect(diff.has("axios")).toBe(false);
  });

  it("includes packages present in only one side", () => {
    const before = JSON.stringify({
      lockfileVersion: 2,
      packages: {
        "node_modules/lodash": { version: "4.17.20" },
      },
    });
    const after = JSON.stringify({
      lockfileVersion: 2,
      packages: {
        "node_modules/axios": { version: "0.21.0" },
      },
    });
    const diff = diffRootNpmLockfileVersions(before, after);
    expect(diff.get("lodash")).toEqual({ before: "4.17.20", after: undefined });
    expect(diff.get("axios")).toEqual({ before: undefined, after: "0.21.0" });
  });

  it("returns empty map when both sides are identical", () => {
    const content = JSON.stringify({
      lockfileVersion: 2,
      packages: { "node_modules/lodash": { version: "4.17.21" } },
    });
    expect(diffRootNpmLockfileVersions(content, content).size).toBe(0);
  });
});
