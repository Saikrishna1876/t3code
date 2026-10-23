import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { type PreviewEvent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import { expect } from "vite-plus/test";

import * as CodespacesPreview from "../codespaces/CodespacesPreview.ts";
import * as ServerConfig from "../config.ts";
import * as PreviewManager from "./Manager.ts";

const DRAIN_LIMIT = 100;

interface EventCollector {
  readonly drain: Effect.Effect<ReadonlyArray<PreviewEvent>>;
}

/**
 * Each `it.effect` shares the live PreviewManager layer across the whole
 * `it.layer` block, so tests that assert per-thread counts must use a unique
 * thread id to avoid bleeding state from earlier tests.
 */
let nextThreadId = 0;
const freshThreadId = () => ThreadId.make(`thread-${++nextThreadId}`);

/**
 * Subscribe to the manager's event stream BEFORE the test publishes. We
 * use `subscribeEvents` (synchronous PubSub.subscribe under the hood) so
 * no event can land between subscribe and the consumer drain.
 */
const collectEvents = Effect.gen(function* () {
  const manager = yield* PreviewManager.PreviewManager;
  const subscription = yield* manager.subscribeEvents;
  const collector: EventCollector = {
    drain: PubSub.takeUpTo(subscription, DRAIN_LIMIT),
  };
  return collector;
}).pipe(Effect.withSpan("preview.test.collectEvents"));

const layer = PreviewManager.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-manager-" })),
  Layer.provide(NodeCrypto.layer),
  Layer.provide(NodeServices.layer),
);

it.layer(layer)("PreviewManager", (it) => {
  it.effect("opens a session and emits opened with normalized URL", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;

      const snapshot = yield* manager.open({ threadId, url: "localhost:5173" });
      expect(snapshot.tabId.startsWith("tab_")).toBe(true);
      expect(snapshot.navStatus._tag).toBe("Loading");
      if (snapshot.navStatus._tag === "Loading") {
        expect(snapshot.navStatus.url).toBe("http://localhost:5173/");
      }

      const events = yield* collector.drain;
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("opened");
      if (events[0]?.type === "opened") {
        expect(events[0].tabId).toBe(snapshot.tabId);
      }
    }),
  );

  it.effect("keeps the tab's profile across navigation and status reports", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;

      const opened = yield* manager.open({ threadId, profileId: "work" });
      expect(opened.profileId).toBe("work");

      const navigated = yield* manager.navigate({
        threadId,
        tabId: opened.tabId,
        url: "localhost:5173",
      });
      expect(navigated.profileId).toBe("work");

      yield* manager.reportStatus({
        threadId,
        tabId: opened.tabId,
        navStatus: { _tag: "Success", url: "http://localhost:5173/", title: "Dev" },
        canGoBack: true,
        canGoForward: false,
      });
      const listed = yield* manager.list({ threadId });
      expect(listed.sessions.find((s) => s.tabId === opened.tabId)?.profileId).toBe("work");
    }),
  );

  it.effect("reissues presentation requests without replaying them on navigation", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;
      const opened = yield* manager.open({ threadId, runtime: "server", reveal: false });
      yield* manager.requestReveal({ threadId, tabId: opened.tabId, force: true });
      const first = (yield* manager.list({ threadId })).sessions[0];
      expect(first?.reveal).toBe(true);
      expect(first?.revealRequest?.force).toBe(true);
      const refused = yield* manager
        .navigate({ threadId, tabId: opened.tabId, url: "localhost:5173" })
        .pipe(Effect.flip);
      expect(refused._tag).toBe("PreviewControlRequiredError");
      yield* manager.reportStatus({
        threadId,
        tabId: opened.tabId,
        serverControlled: true,
        navStatus: { _tag: "Success", url: "http://localhost:5173/", title: "Dev" },
        canGoBack: false,
        canGoForward: false,
      });
      expect((yield* manager.list({ threadId })).sessions[0]?.revealRequest).toEqual(
        first?.revealRequest,
      );
      yield* manager.requestReveal({ threadId, tabId: opened.tabId, force: false });
      const second = (yield* manager.list({ threadId })).sessions[0];
      expect(second?.revealRequest?.id).not.toBe(first?.revealRequest?.id);
      expect(second?.revealRequest?.force).toBe(false);
      const events = yield* collector.drain;
      const last = events.at(-1);
      expect(last?.type).toBe("navigated");
      if (last?.type === "navigated")
        expect(last.snapshot.revealRequest).toEqual(second?.revealRequest);
    }),
  );

  it.effect("orders list snapshots and events with one monotonic revision", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;
      const before = yield* manager.list({ threadId });

      const opened = yield* manager.open({ threadId, url: "http://localhost:5173" });
      yield* manager.navigate({
        threadId,
        tabId: opened.tabId,
        url: "http://localhost:5173/ready",
      });

      const events = yield* collector.drain;
      const listed = yield* manager.list({ threadId });
      expect(events).toHaveLength(2);
      expect(events[0]!.serverEpoch).toBe(listed.serverEpoch);
      expect(events[1]!.serverEpoch).toBe(listed.serverEpoch);
      expect(events[0]!.revision).toBeGreaterThan(before.revision);
      expect(events[1]!.revision).toBeGreaterThan(events[0]!.revision);
      expect(listed.revision).toBe(events[1]!.revision);
      expect(listed.sessions).toHaveLength(1);
    }),
  );

  it.effect("resizes a tab and preserves its viewport across navigation reports", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;
      const opened = yield* manager.open({ threadId, url: "http://localhost:5173" });

      const resized = yield* manager.resize({
        threadId,
        tabId: opened.tabId,
        viewport: { _tag: "freeform", width: 1024, height: 768 },
      });
      expect(resized.viewport).toEqual({ _tag: "freeform", width: 1024, height: 768 });

      const navigated = yield* manager.navigate({
        threadId,
        tabId: opened.tabId,
        url: "http://localhost:5173/resized",
      });
      expect(navigated.viewport).toEqual(resized.viewport);

      yield* manager.reportStatus({
        threadId,
        tabId: opened.tabId,
        navStatus: { _tag: "Success", url: "http://localhost:5173/resized", title: "Resized" },
        canGoBack: true,
        canGoForward: false,
      });
      const listed = yield* manager.list({ threadId });
      expect(listed.sessions[0]?.viewport).toEqual(resized.viewport);

      const events = yield* collector.drain;
      expect(events.map((event) => event.type)).toEqual([
        "opened",
        "resized",
        "navigated",
        "navigated",
      ]);
    }),
  );

  it.effect(
    "rejects client status reports for server tabs without changing state or emitting events",
    () =>
      Effect.gen(function* () {
        const threadId = freshThreadId();
        const manager = yield* PreviewManager.PreviewManager;
        const opened = yield* manager.open({ threadId, runtime: "server", reveal: false });
        const collector = yield* collectEvents;
        const before = yield* manager.list({ threadId });
        const input = {
          threadId,
          tabId: opened.tabId,
          navStatus: {
            _tag: "Success" as const,
            url: "http://localhost:5173/changed",
            title: "Changed",
          },
          canGoBack: true,
          canGoForward: true,
        };
        const rejected = yield* manager.reportStatus(input).pipe(Effect.flip);
        expect(rejected._tag).toBe("PreviewControlRequiredError");
        expect(yield* manager.list({ threadId })).toEqual(before);
        expect(yield* collector.drain).toEqual([]);

        yield* manager.reportStatus({ ...input, serverControlled: true });
        expect((yield* manager.list({ threadId })).sessions[0]).toMatchObject({
          navStatus: input.navStatus,
          canGoBack: true,
          canGoForward: true,
        });
        const events = yield* collector.drain;
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          type: "navigated",
          snapshot: { navStatus: input.navStatus },
        });
      }),
  );

  it.effect("gives every tab in a batch close its own monotonic revision", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      yield* manager.open({ threadId, url: "http://localhost:5173" });
      yield* manager.open({ threadId, url: "http://localhost:3000" });
      const collector = yield* collectEvents;

      yield* manager.close({ threadId });

      const events = yield* collector.drain;
      const listed = yield* manager.list({ threadId });
      expect(events).toHaveLength(2);
      expect(events.every((event) => event.type === "closed")).toBe(true);
      expect(events[1]!.revision).toBeGreaterThan(events[0]!.revision);
      expect(listed.revision).toBe(events[1]!.revision);
      expect(listed.sessions).toHaveLength(0);
    }),
  );

  it.effect("close with explicit tabId removes only that tab", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const a = yield* manager.open({ threadId, url: "http://localhost:5173" });
      const b = yield* manager.open({ threadId, url: "http://localhost:3000" });

      yield* manager.close({ threadId, tabId: a.tabId });

      const list = yield* manager.list({ threadId });
      expect(list.sessions.map((s) => s.tabId)).toEqual([b.tabId]);
    }),
  );
});

it.effect("resolves a remote workspace URL before a client-owned browser navigates", () =>
  Effect.gen(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    const threadId = freshThreadId();
    const tab = yield* manager.open({ threadId });
    expect(yield* manager.resolveUrl({ threadId, url: "localhost:4173/page?x=1" })).toBe(
      "http://127.0.0.1:60000/page?x=1",
    );
    // Resolution does not navigate or claim browser control.
    expect((yield* manager.list({ threadId })).sessions[0]?.navStatus._tag).toBe("Idle");
    expect(tab.tabId).toBeTruthy();
    const opened = yield* manager.open({ threadId, url: "localhost:4173/page?x=1" });
    expect(opened.navStatus).toMatchObject({ url: "http://127.0.0.1:60000/page?x=1" });
    expect(opened.sourceUrl).toBe("http://localhost:4173/page?x=1");
    const navigated = yield* manager.navigate({
      threadId,
      tabId: tab.tabId,
      url: "localhost:4173/next",
    });
    expect(navigated.navStatus).toMatchObject({ url: "http://127.0.0.1:60000/next" });
    yield* manager.reportStatus({
      threadId,
      tabId: tab.tabId,
      navStatus: { _tag: "Success", url: "http://127.0.0.1:60000/login", title: "Login" },
      canGoBack: true,
      canGoForward: false,
    });
    expect(
      (yield* manager.list({ threadId })).sessions.find((item) => item.tabId === tab.tabId)
        ?.sourceUrl,
    ).toBe("http://localhost:4173/login");
  }).pipe(
    Effect.provide(
      layer.pipe(
        Layer.provide(
          Layer.mock(CodespacesPreview.CodespacesPreview)({
            workspaceUrl: (_threadId, url) =>
              Effect.succeed(url.replace("127.0.0.1:60000", "localhost:4173")),
            resolve: (_threadId, url) =>
              Effect.succeed(url.replace("localhost:4173", "127.0.0.1:60000")),
          }),
        ),
      ),
    ),
  ),
);

it.effect("refresh resolves the application URL again after a Codespace reconnect", () => {
  let port = 60000;
  return Effect.gen(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    const threadId = freshThreadId();
    const opened = yield* manager.open({ threadId, url: "http://localhost:4173/page?x=1" });
    const events = yield* manager.subscribeEvents;
    port = 61000;
    yield* manager.refresh({ threadId, tabId: opened.tabId });
    const updated = (yield* manager.list({ threadId })).sessions[0]!;
    expect(updated.navStatus).toMatchObject({ url: "http://127.0.0.1:61000/page?x=1" });
    expect(updated.sourceUrl).toBe("http://localhost:4173/page?x=1");
    expect((yield* PubSub.takeUpTo(events, DRAIN_LIMIT)).map((event) => event.type)).toEqual([
      "navigated",
    ]);
  }).pipe(
    Effect.provide(
      layer.pipe(
        Layer.provide(
          Layer.mock(CodespacesPreview.CodespacesPreview)({
            workspaceUrl: (_threadId, url) =>
              Effect.succeed(url.replace(/127\.0\.0\.1:6\d{4}/, "localhost:4173")),
            resolve: (_threadId, url) =>
              Effect.succeed(url.replace("localhost:4173", `127.0.0.1:${port}`)),
          }),
        ),
      ),
    ),
  );
});

it.effect("remote refresh leaves other tabs usable and preserves concurrent navigation", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const ready = yield* Deferred.make<void>();
    let blockNextResolution = false;
    yield* Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;
      const threadId = freshThreadId();
      const opened = yield* manager.open({ threadId, url: "http://localhost:4173/page" });
      const events = yield* manager.subscribeEvents;
      blockNextResolution = true;
      const refresh = yield* manager
        .refresh({ threadId, tabId: opened.tabId })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const otherThread = freshThreadId();
      yield* manager.open({ threadId: otherThread });
      expect((yield* manager.list({ threadId: otherThread })).sessions).toHaveLength(1);
      const navigated = yield* manager.navigate({
        threadId,
        tabId: opened.tabId,
        url: "http://localhost:4173/page",
        resolvedTitle: "New navigation",
      });
      yield* Deferred.succeed(ready, undefined);
      yield* Fiber.join(refresh);
      expect((yield* manager.list({ threadId })).sessions[0]).toEqual(navigated);
      expect((yield* PubSub.takeUpTo(events, DRAIN_LIMIT)).map((event) => event.type)).toEqual([
        "opened",
        "navigated",
      ]);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            Layer.mock(CodespacesPreview.CodespacesPreview)({
              workspaceUrl: (_threadId, url) =>
                Effect.succeed(url.replace("127.0.0.1:60000", "localhost:4173")),
              resolve: (_threadId, url) =>
                Effect.suspend(() => {
                  if (!blockNextResolution)
                    return Effect.succeed(url.replace("localhost:4173", "127.0.0.1:60000"));
                  blockNextResolution = false;
                  return Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(ready)),
                    Effect.as(url.replace("localhost:4173", "127.0.0.1:61000")),
                  );
                }),
            }),
          ),
        ),
      ),
    );
  }),
);

it.effect("remote status resolution leaves other preview sessions usable", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const ready = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;
      const threadId = freshThreadId();
      const opened = yield* manager.open({ threadId });
      const report = yield* manager
        .reportStatus({
          threadId,
          tabId: opened.tabId,
          navStatus: { _tag: "Success", url: "http://127.0.0.1:60000/page", title: "Page" },
          canGoBack: false,
          canGoForward: false,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const otherThread = freshThreadId();
      yield* manager.open({ threadId: otherThread });
      expect((yield* manager.list({ threadId: otherThread })).sessions).toHaveLength(1);
      yield* Deferred.succeed(ready, undefined);
      yield* Fiber.join(report);
      expect((yield* manager.list({ threadId })).sessions[0]?.sourceUrl).toBe(
        "http://localhost:4173/page",
      );
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            Layer.mock(CodespacesPreview.CodespacesPreview)({
              workspaceUrl: (_threadId, url) =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(ready)),
                  Effect.as(url.replace("127.0.0.1:60000", "localhost:4173")),
                ),
            }),
          ),
        ),
      ),
    );
  }),
);

it.effect("a delayed remote status report cannot overwrite a newer status", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const ready = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;
      const threadId = freshThreadId();
      const opened = yield* manager.open({ threadId });
      const events = yield* manager.subscribeEvents;
      const report = (path: string) =>
        manager.reportStatus({
          threadId,
          tabId: opened.tabId,
          navStatus: { _tag: "Success", url: `http://127.0.0.1:60000/${path}`, title: path },
          canGoBack: false,
          canGoForward: false,
        });
      const older = yield* report("old").pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* report("new");
      const latest = (yield* manager.list({ threadId })).sessions[0];
      yield* Deferred.succeed(ready, undefined);
      yield* Fiber.join(older);
      expect((yield* manager.list({ threadId })).sessions[0]).toEqual(latest);
      expect(latest?.sourceUrl).toBe("http://localhost:4173/new");
      expect((yield* PubSub.takeUpTo(events, DRAIN_LIMIT)).map((event) => event.type)).toEqual([
        "navigated",
      ]);
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            Layer.mock(CodespacesPreview.CodespacesPreview)({
              workspaceUrl: (_threadId, url) =>
                (url.endsWith("/old")
                  ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(ready)))
                  : Effect.void
                ).pipe(Effect.as(url.replace("127.0.0.1:60000", "localhost:4173"))),
            }),
          ),
        ),
      ),
    );
  }),
);
