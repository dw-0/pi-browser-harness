import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserLaunchArgs, launchBrowser, openProfileWindow } from "../../src/profile/launch";

describe("openProfileWindow's failure reporting", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "pi-launch-"));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("L1", () => {
    const missing = (): string => join(root, "chrome (deleted)");

    test("L1: a missing executable fails the launch", async () => {
      const r = await openProfileWindow({ exePath: missing(), profileDir: "Default" });
      assert.ok(!r.success);
    });

    test("L1: the error names the path that could not be launched", async () => {
      const r = await openProfileWindow({ exePath: missing(), profileDir: "Default" });
      assert.ok(!r.success);
      assert.ok(r.error.includes(missing()));
    });

    test("L1: the error carries spawn's own cause", async () => {
      const r = await openProfileWindow({ exePath: missing(), profileDir: "Default" });
      assert.ok(!r.success);
      assert.ok(r.error.includes("ENOENT"));
    });
  });

  test(
    "L2: a non-executable file fails the launch",
    { skip: process.platform === "win32" || process.getuid?.() === 0 },
    async () => {
      const notExec = join(root, "not-executable");
      writeFileSync(notExec, "#!/bin/sh\n", { mode: 0o644 });
      const r = await openProfileWindow({ exePath: notExec, profileDir: "Default" });
      assert.ok(!r.success);
    },
  );

  describe("L3", () => {
    let before_: string | undefined;

    before(() => {
      before_ = process.env["TMPDIR"];
      process.env["TMPDIR"] = root;
    });

    after(() => {
      if (before_ === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = before_;
    });

    test("L3: launch failed as set up", async () => {
      const r = await openProfileWindow({ exePath: join(root, "absent"), profileDir: "Default" });
      assert.ok(!r.success);
    });

    test("L3: no handshake page is left on disk after a failed launch", async () => {
      await openProfileWindow({ exePath: join(root, "absent"), profileDir: "Default" });
      const leftovers = readdirSync(root).filter((n) => n.startsWith("pi-harness-"));
      assert.equal(leftovers.length, 0);
    });
  });

  describe("L4", () => {
    let r: Awaited<ReturnType<typeof openProfileWindow>>;

    before(async () => {
      const stub = join(root, "stub-browser");
      writeFileSync(stub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      r = await openProfileWindow({ exePath: stub, profileDir: "Default" });
    });

    test("L4: a startable binary yields a handle", () => {
      assert.ok(r.success);
    });

    test("L4: the sentinel page exists before the browser is polled", () => {
      assert.ok(r.success);
      const sentinel = fileURLToPath(r.data.sentinelUrl);
      assert.ok(existsSync(sentinel));
    });

    test("L4: cleanup removes the sentinel page", async () => {
      assert.ok(r.success);
      const sentinel = fileURLToPath(r.data.sentinelUrl);
      await r.data.cleanup();
      assert.ok(!existsSync(sentinel));
    });

    test("L4: kill is safe to call twice", () => {
      assert.ok(r.success);
      r.data.kill();
      r.data.kill();
    });
  });

  test("L5: a request with neither an executable nor a flatpak app fails without spawning", async () => {
    const r = await openProfileWindow({ profileDir: "Default" });
    assert.ok(!r.success);
    assert.ok(r.error.includes("no browser executable"));
  });
});

describe("openProfileWindow's flatpak launch", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "pi-launch-flatpak-"));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("F1: a flatpak request spawns the flatpak launcher with run <appId> and the profile args", async () => {
    writeFileSync(join(root, "flatpak"), `#!/bin/sh\nprintf '%s\\0' "$@" > "${root}/argv"\n`, { mode: 0o755 });
    const oldPath = process.env["PATH"] ?? "";
    process.env["PATH"] = `${root}:${oldPath}`;
    try {
      const r = await openProfileWindow({ flatpakAppId: "com.google.Chrome", profileDir: "Default" });
      assert.ok(r.success);
      if (r.success) {
        // spawn succeeding is not the stub having run: wait for the argv file to appear.
        const deadline = Date.now() + 2000;
        while (!existsSync(join(root, "argv")) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 20));
        await r.data.cleanup();
      }
    } finally {
      process.env["PATH"] = oldPath;
    }
    const argv = readFileSync(join(root, "argv"), "utf8").split("\0").filter(Boolean);
    assert.deepEqual(argv, ["run", "com.google.Chrome", "--profile-directory=Default", "--new-window", argv.at(-1)]);
    assert.match(argv.at(-1) ?? "", /^file:\/\//);
  });
});

describe("launchBrowser", () => {
  test("a missing executable is reported with the path and spawn's own cause", async () => {
    const missing = join(tmpdir(), "pi-launch-no-such-browser");
    const r = await launchBrowser({ exePath: missing });
    assert.ok(!r.success);
    assert.ok(r.error.includes(missing));
    assert.ok(r.error.includes("ENOENT"));
  });

  test("an executable that starts is a successful launch", { skip: process.platform === "win32" }, async () => {
    const r = await launchBrowser({ exePath: "/bin/sh", profileDir: "Default" });
    assert.ok(r.success);
  });

  test("a pinned profile is passed as --profile-directory; without one the browser picks its own", () => {
    assert.deepEqual(browserLaunchArgs({ exePath: "/x", profileDir: "Profile 1" }), ["--profile-directory=Profile 1"]);
    assert.deepEqual(browserLaunchArgs({ exePath: "/x" }), []);
  });
});
