import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { seedProfileWindow, type SeedDeps } from "../../src/profile/bind";
import type { BrowserClient } from "../../src/client";
import type { ProfilePin } from "../../src/profile/store";
import type { RunningBrowser } from "../../src/profile/browser-process";
import type { ProfileWindowRequest } from "../../src/profile/launch";
import { cdpError } from "../../src/cdp/errors";
import { err, ok } from "../../src/util/result";
import { createFakeClient, type Canned, type FakeClient } from "../domains/fake-client";
import { underNeverActivate } from "../helpers/never-activate";

const pin: ProfilePin = {
  userDataDir: "/home/u/.config/google-chrome",
  profileDir: "Profile 1",
  label: "Work (work@example.com)",
  savedAt: "",
};

const SENTINEL = "file:///tmp/pi-harness-abc.html";
const EXE = "/usr/bin/google-chrome";

const page = (targetId: string, url: string, browserContextId?: string) => ({
  targetId,
  type: "page",
  title: "",
  url,
  ...(browserContextId === undefined ? {} : { browserContextId }),
});

type Seeded = {
  readonly fake: FakeClient;
  readonly client: BrowserClient;
  readonly deps: SeedDeps;
  readonly launches: ReadonlyArray<ProfileWindowRequest>;
  readonly detects: ReadonlyArray<string | undefined>;
  readonly sleeps: ReadonlyArray<number>;
  readonly contexts: ReadonlyArray<string | undefined>;
  readonly cleanups: () => number;
  readonly kills: () => number;
};

// The machine-facing steps are recorders; the clock advances by exactly the slept amount so the
// deadline is deterministic. `canned` queues the CDP answers; the fake client's own attach
// consumes the first entry of each method's queue. The running-browser path needs a canned
// Target.createTarget, so one is merged in unless the test overrides it.
const seeded = async (opts: {
  readonly canned?: Canned;
  readonly running?: RunningBrowser;
  readonly exePath?: string | undefined;
  readonly launchError?: string;
  readonly deadlineMs?: number;
  readonly createTargetId?: string;
} = {}): Promise<Seeded> => {
  const createTargetId = opts.createTargetId ?? "seed";
  const fake = await createFakeClient({
    canned: { "Target.createTarget": ok({ targetId: createTargetId }), ...(opts.canned ?? {}) },
  });
  const contexts: Array<string | undefined> = [];
  const client: BrowserClient = { ...fake.client, setProfileContextId: (id) => { contexts.push(id); } };
  const launches: ProfileWindowRequest[] = [];
  const detects: Array<string | undefined> = [];
  const sleeps: number[] = [];
  let cleanups = 0;
  let kills = 0;
  let clock = 1_000;
  const running: RunningBrowser = opts.running ?? { running: true, exePath: EXE };
  const deps: SeedDeps = {
    detectRunningBrowser: (prefer) => { detects.push(prefer); return Promise.resolve(running); },
    resolveBrowserExecutable: () => Promise.resolve("exePath" in opts ? opts.exePath : EXE),
    openProfileWindow: (req) => {
      launches.push(req);
      if (opts.launchError !== undefined) return Promise.resolve(err(opts.launchError));
      return Promise.resolve(ok({
        sentinelUrl: SENTINEL,
        cleanup: () => { cleanups++; return Promise.resolve(); },
        kill: () => { kills++; },
      }));
    },
    sleep: (ms) => { sleeps.push(ms); clock += ms; return Promise.resolve(); },
    now: () => clock,
    deadlineMs: opts.deadlineMs ?? 1_500,
    pollMs: 500,
  };
  return { fake, client, deps, launches, detects, sleeps, contexts, cleanups: () => cleanups, kills: () => kills };
};

// Canned for the running-browser path: the fake's attach consumes the first Target.getTargets and
// Browser.getWindowForTarget entries, then the seed lists pages for the opener, asks for the
// default context, creates the tab, and lists pages again for the created tab's context.
const runningCanned = (withContext: boolean): Canned => ({
  "Target.getTargets": [
    ok({ targetInfos: [page("t1", "https://example.test/", "ctx-9")] }),
    ok({ targetInfos: [page("t1", "https://example.test/", "ctx-9")] }),
    ok({ targetInfos: [
      page("t1", "https://example.test/", "ctx-9"),
      page("seed", "about:blank", withContext ? "ctx-9" : undefined),
    ] }),
  ],
  "Target.getBrowserContexts": ok({ defaultBrowserContextId: "ctx-9" }),
  "Browser.getWindowForTarget": ok({ windowId: 42 }),
});

describe("seedProfileWindow", () => {
  test("refuses to seed when the connected browser is a different user-data-dir than the pin's", async () => {
    const s = await seeded();
    const client: BrowserClient = { ...s.client, userDataDir: () => "/home/u/.config/BraveSoftware/Brave-Browser" };
    const windowBefore = s.fake.ownership.harnessWindow();

    const r = await seedProfileWindow(client, pin, s.deps);

    assert.equal(r.success, false);
    assert.equal(r.error.kind, "discovery_failed");
    assert.match(r.error.message, /"Work \(work@example\.com\)" belongs to \/home\/u\/\.config\/google-chrome/);
    assert.match(r.error.message, /connected to \/home\/u\/\.config\/BraveSoftware\/Brave-Browser/);
    assert.match(r.error.message, /\/browser-profile/);
    assert.equal(s.fake.calls.length, 0, "no CDP traffic before the guard");
    assert.deepEqual(s.contexts, []);
    assert.deepEqual(s.detects, [], "the machine is not scanned");
    assert.deepEqual(s.launches, []);
    assert.equal(s.fake.ownership.harnessWindow(), windowBefore, "ownership is untouched");
  });

  test("the mismatch check is exact, not a prefix match", async () => {
    const s = await seeded();
    const client: BrowserClient = { ...s.client, userDataDir: () => `${pin.userDataDir}-beta` };
    const r = await seedProfileWindow(client, pin, s.deps);
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "discovery_failed");
    assert.match(r.error.message, /belongs to/);
  });

  test("opens the seed as a sibling tab in the user's window via CDP, launching no second process or window", async () => {
    const s = await seeded({ canned: runningCanned(true) });

    const r = await seedProfileWindow(s.client, pin, s.deps);

    assert.ok(r.success, r.success ? "" : r.error.message);
    assert.equal(r.data, "seed");
    assert.deepEqual(s.launches, [], "no second process is launched");
    assert.deepEqual(s.sleeps, [], "nothing is polled");
    assert.deepEqual(s.detects, [pin.userDataDir]);
    const created = s.fake.callsTo("Target.createTarget")[0];
    assert.ok(created);
    assert.deepEqual(created.params, { url: "about:blank", openerId: "t1" }, "a tab in the existing window, not a new one");
    assert.deepEqual(s.contexts, ["ctx-9"], "the created tab's context is the profile's");
    assert.equal(s.fake.ownership.harnessWindow(), "seed");
    assert.equal(s.fake.ownership.has("seed"), true);
    assert.equal(s.fake.ownership.harnessWindowId(), 42);
    assert.equal(s.fake.callsTo("Target.attachToTarget").length, 0, "the created tab is not reset via a borrowed session");
  });

  test("background mode flags the CDP createTarget and still launches no second process", async () => {
    const s = await seeded({ canned: runningCanned(true) });

    const r = await underNeverActivate(() => seedProfileWindow(s.client, pin, s.deps));

    assert.ok(r.success, r.success ? "" : r.error.message);
    const created = s.fake.callsTo("Target.createTarget")[0];
    assert.ok(created);
    assert.deepEqual(created.params, { url: "about:blank", openerId: "t1", background: true });
    assert.deepEqual(s.launches, [], "background mode seeds via CDP, no process launch");
    assert.deepEqual(s.contexts, ["ctx-9"]);
  });

  test("no context reported by the created tab leaves the profile context unset", async () => {
    const s = await seeded({ canned: runningCanned(false) });

    const r = await seedProfileWindow(s.client, pin, s.deps);

    assert.ok(r.success);
    assert.equal(r.data, "seed");
    assert.deepEqual(s.contexts, [], "no context is recorded when the tab reports none");
    assert.equal(s.fake.ownership.harnessWindow(), "seed");
    assert.equal(s.fake.ownership.has("seed"), true);
  });

  test("falls back to a new window when no page is open in the default context", async () => {
    const s = await seeded({
      canned: {
        "Target.getTargets": [
          ok({ targetInfos: [page("t1", "https://example.test/", "ctx-incognito")] }),
          ok({ targetInfos: [page("t1", "https://example.test/", "ctx-incognito")] }),
          ok({ targetInfos: [page("t1", "https://example.test/", "ctx-incognito"), page("seed", "about:blank", "ctx-9")] }),
        ],
        "Target.getBrowserContexts": ok({ defaultBrowserContextId: "ctx-9" }),
      },
    });

    const r = await seedProfileWindow(s.client, pin, s.deps);

    assert.ok(r.success, r.success ? "" : r.error.message);
    const created = s.fake.callsTo("Target.createTarget")[0];
    assert.ok(created);
    assert.deepEqual(created.params, { url: "about:blank", newWindow: true }, "no default-context opener → a fresh window");
    assert.deepEqual(s.contexts, ["ctx-9"], "the fresh window lands in the default context");
    assert.deepEqual(s.launches, []);
  });

  test("an empty-string default context matches a page with no reported context", async () => {
    const s = await seeded({
      canned: {
        "Target.getTargets": [
          ok({ targetInfos: [page("t1", "https://example.test/")] }),
          ok({ targetInfos: [page("t1", "https://example.test/")] }),
          ok({ targetInfos: [page("t1", "https://example.test/"), page("seed", "about:blank")] }),
        ],
        "Target.getBrowserContexts": ok({ defaultBrowserContextId: "" }),
      },
    });

    const r = await seedProfileWindow(s.client, pin, s.deps);

    assert.ok(r.success, r.success ? "" : r.error.message);
    const created = s.fake.callsTo("Target.createTarget")[0];
    assert.ok(created);
    assert.deepEqual(created.params, { url: "about:blank", openerId: "t1" });
    assert.deepEqual(s.contexts, []);
  });

  test("a CDP createTarget failure fails the seed without launching or polling", async () => {
    const s = await seeded({
      canned: { "Target.createTarget": err(cdpError("remote_error", "nope")) },
    });

    const r = await seedProfileWindow(s.client, pin, s.deps);

    assert.equal(r.success, false);
    assert.equal(r.error.kind, "remote_error");
    assert.deepEqual(s.launches, [], "a failed CDP tab does not fall back to a process launch");
    assert.deepEqual(s.sleeps, []);
    assert.equal(s.fake.ownership.has("seed"), false, "ownership is untouched");
  });

  test("when no browser is running, launches one and polls for the sentinel", async () => {
    const s = await seeded({
      running: { running: false },
      canned: {
        "Target.getTargets": [
          ok({ targetInfos: [page("t1", "https://example.test/")] }),
          ok({ targetInfos: [page("t1", "https://example.test/")] }),
          ok({ targetInfos: [page("t1", "https://example.test/"), page("seed", SENTINEL, "ctx-9")] }),
        ],
        "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s-seed" })],
        "Browser.getWindowForTarget": [ok({ windowId: 7 }), ok({ windowId: 42 })],
      },
    });

    const r = await seedProfileWindow(s.client, pin, s.deps);

    assert.ok(r.success, r.success ? "" : r.error.message);
    assert.equal(r.data, "seed");
    assert.deepEqual(s.launches, [{ exePath: EXE, profileDir: "Profile 1" }]);
    assert.deepEqual(s.sleeps, [500, 500], "one poll missed the sentinel, the next found it");
    assert.deepEqual(s.contexts, ["ctx-9"], "the sentinel's browser context is the profile's");
    assert.equal(s.fake.ownership.harnessWindow(), "seed");
    assert.equal(s.fake.ownership.has("seed"), true);
    assert.equal(s.fake.ownership.harnessWindowId(), 42);

    const navigate = s.fake.callsTo("Page.navigate")[0];
    assert.ok(navigate);
    assert.deepEqual(navigate.params, { url: "about:blank" });
    assert.equal(navigate.sessionId, "s-seed", "the reset rides on the borrowed session");
  });

  test("the fallback launcher forwards a detected user-data-dir", async () => {
    const s = await seeded({
      running: { running: false, explicitUserDataDir: "/home/u/.config/google-chrome" },
      canned: {
        "Target.getTargets": [
          ok({ targetInfos: [page("t1", "https://example.test/")] }),
          ok({ targetInfos: [page("seed", SENTINEL)] }),
        ],
      },
    });
    const r = await seedProfileWindow(s.client, pin, s.deps);
    assert.ok(r.success);
    assert.deepEqual(s.launches, [{ exePath: EXE, profileDir: "Profile 1", explicitUserDataDir: "/home/u/.config/google-chrome" }]);
    assert.deepEqual(s.contexts, [], "no context is recorded when the sentinel reports none");
  });

  test("a sentinel tab the harness already tracks is reset on that session without a detach", async () => {
    const s = await seeded({
      running: { running: false },
      canned: {
        "Target.getTargets": [
          ok({ targetInfos: [page("t1", "https://example.test/")] }),
          ok({ targetInfos: [page("t1", SENTINEL)] }),
        ],
      },
    });
    const r = await seedProfileWindow(s.client, pin, s.deps);
    assert.ok(r.success);
    assert.equal(r.data, "t1");
    assert.equal(s.fake.callsTo("Page.navigate")[0]?.sessionId, "s1");
    assert.equal(s.fake.callsTo("Target.attachToTarget").length, 0);
    assert.equal(s.fake.callsTo("Target.detachFromTarget").length, 0);
  });

  test("the sentinel is still cleaned up when the borrowed attach fails", async () => {
    const s = await seeded({
      running: { running: false },
      canned: {
        "Target.getTargets": [
          ok({ targetInfos: [page("t1", "https://example.test/")] }),
          ok({ targetInfos: [page("seed", SENTINEL)] }),
        ],
        "Target.attachToTarget": [ok({ sessionId: "s1" }), err(cdpError("remote_error", "gone"))],
      },
    });
    const r = await seedProfileWindow(s.client, pin, s.deps);
    assert.ok(r.success, "a failed reset does not fail the seed");
    assert.equal(s.fake.callsTo("Page.navigate").length, 0);
    assert.equal(s.cleanups(), 1);
  });

  test("no browser executable is a discovery failure with the manual fallback", async () => {
    const s = await seeded({ exePath: undefined, running: { running: false } });
    const r = await seedProfileWindow(s.client, pin, s.deps);
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "discovery_failed");
    assert.match(r.error.message, /could not locate the browser executable needed to open "Work \(work@example\.com\)"/);
    assert.match(r.error.message, /browser profile menu → Profile 1/);
    assert.deepEqual(s.launches, []);
    assert.equal(s.fake.calls.length, 0);
  });

  test("a failed launch is a discovery failure carrying the launcher's reason", async () => {
    const s = await seeded({ launchError: "could not launch /usr/bin/google-chrome: ENOENT", running: { running: false } });
    const r = await seedProfileWindow(s.client, pin, s.deps);
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "discovery_failed");
    assert.match(r.error.message, /^could not launch \/usr\/bin\/google-chrome: ENOENT — open a window for "Work/);
    assert.deepEqual(s.sleeps, [], "nothing is polled");
    assert.equal(s.fake.calls.length, 0);
  });

  test("a sentinel that never appears times out, kills the launcher and leaves ownership untouched", async () => {
    const s = await seeded({ deadlineMs: 1_500, running: { running: false } });
    const windowBefore = s.fake.ownership.harnessWindow();
    const r = await seedProfileWindow(s.client, pin, s.deps);
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
    assert.match(r.error.message, /couldn't open a window in "Work \(work@example\.com\)" automatically/);
    assert.deepEqual(s.sleeps, [500, 500, 500], "polls until the deadline passes");
    assert.equal(s.fake.callsTo("Target.getTargets").length, 3);
    assert.equal(s.kills(), 1);
    assert.equal(s.cleanups(), 1);
    assert.deepEqual(s.contexts, []);
    assert.equal(s.fake.ownership.harnessWindow(), windowBefore);
    assert.equal(s.fake.callsTo("Page.navigate").length, 0);
  });
});
