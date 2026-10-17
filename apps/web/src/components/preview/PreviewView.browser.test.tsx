import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
} from "@t3tools/contracts";
import { act, Profiler, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import type { PreviewableServer } from "./useDiscoveredLocalServers";

const mocks = vi.hoisted(() => ({
  supportsCodespaces: false,
  sourceUrl: undefined as string | undefined,
  hardReload: vi.fn(async () => undefined),
  refresh: vi.fn(async () => undefined),
  canResolveUrl: true,
  primaryEnvironmentId: "environment-1" as EnvironmentId,
  openPreviewSession: vi.fn(),
  closePreviewSession: vi.fn(),
  openBrowser: vi.fn(),
  resolveUrl: vi.fn(async () => ({ _tag: "Success", value: "http://localhost:14528/app" })),
  navigate: vi.fn(async (_tabId: string, _url: string): Promise<void> => undefined),
  rememberPreviewUrl: vi.fn(),
  readPreparedConnection: vi.fn(() => ({ httpBaseUrl: "http://172.25.85.75:3773" })),
  readEnvironmentScope: vi.fn((_environmentId?: unknown, _scope?: unknown) => true),
  setAnnotationSendEnabled: vi.fn(async (_tabId: string, _enabled: boolean): Promise<void> => {}),
  cancelPickElement: vi.fn(async (_tabId: string) => undefined),
  openPictureInPicture: vi.fn(async (_tabId: string): Promise<void> => undefined),
  closePictureInPicture: vi.fn(async (_tabId: string): Promise<void> => undefined),
  pickElement: vi.fn(),
  addPreviewAnnotation: vi.fn(),
  addImage: vi.fn(),
  toast: vi.fn(),
  pictureInPicture: false,
  showEmptyState: false,
  loading: false,
  serverEpoch: null as string | null,
  servers: [] as PreviewableServer[],
  recordingTabIds: new Set<string>(),
  recordingRuntimeTabId: null as string | null,
  recordVisitForThread: vi.fn(),
}));

const STUB_BROWSER_DEFAULTS = {
  viewport: FILL_PREVIEW_VIEWPORT,
  zoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR,
  appearance: DEFAULT_PREVIEW_APPEARANCE,
  autoShowFloatingPreview: true,
  profiles: BUILT_IN_BROWSER_PROFILES,
  profileId: DEFAULT_BROWSER_PROFILE_ID,
};

// The desktop bridge only exists inside Electron; the view reads it once at import.
vi.mock(import("./previewBridge"), async (original) => ({
  ...(await original()),
  previewBridge: {
    navigate: mocks.navigate,
    pickElement: mocks.pickElement,
    setAnnotationSendEnabled: mocks.setAnnotationSendEnabled,
    cancelPickElement: mocks.cancelPickElement,
    refresh: mocks.refresh,
    goBack: vi.fn(async () => undefined),
    goForward: vi.fn(async () => undefined),
    hardReload: mocks.hardReload,
    openDevTools: vi.fn(async () => undefined),
    setColorScheme: vi.fn(async () => undefined),
    zoomIn: vi.fn(async () => undefined),
    zoomOut: vi.fn(async () => undefined),
    resetZoom: vi.fn(async () => undefined),
    clearCookies: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
    pictureInPicture: {
      open: mocks.openPictureInPicture,
      close: mocks.closePictureInPicture,
    },
  } as never,
}));
vi.mock(import("~/browserHistoryStore"), async (original) => ({
  ...(await original()),
  recordVisitForThread: mocks.recordVisitForThread,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readPreparedConnection: mocks.readPreparedConnection as never,
  readEnvironmentScope: mocks.readEnvironmentScope,
  useEnvironmentScope: mocks.readEnvironmentScope,
}));
vi.mock(import("~/browser/browserDefaults"), async (original) => ({
  ...(await original()),
  useBrowserDefaults: () => STUB_BROWSER_DEFAULTS,
  getBrowserDefaults: () => STUB_BROWSER_DEFAULTS,
}));
vi.mock(import("~/previewStateStore"), async (original) => ({
  ...(await original()),
  rememberPreviewUrl: mocks.rememberPreviewUrl,
  useThreadPreviewState: (() => ({
    activeTabId: "tab-1",
    serverEpoch: mocks.serverEpoch,
    desktopByTabId: {
      "tab-1": {
        hasWebContents: true,
        canGoBack: false,
        canGoForward: false,
        loading: mocks.loading,
        zoomFactor: 1,
        pictureInPicture: mocks.pictureInPicture,
        colorScheme: "system",
        audioMuted: false,
        audible: false,
        controller: "none",
      },
    },
    recentlySeenUrls: [],
    sessions: mocks.showEmptyState
      ? {}
      : {
          "tab-1": {
            sourceUrl: mocks.sourceUrl,
            threadId: "thread-1",
            tabId: "tab-1",
            navStatus: { _tag: "Success", url: "http://example.com/", title: "Example" },
            canGoBack: false,
            canGoForward: false,
            updatedAt: "2026-07-13T00:00:00.000Z",
          },
        },
  })) as never,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: (() => ({
    label: "WSL",
    serverConfig: { environment: { capabilities: { codespaces: mocks.supportsCodespaces } } },
  })) as never,
  useEnvironmentHttpBaseUrl: () => "http://172.25.85.75:3773",
  usePrimaryEnvironmentId: () => mocks.primaryEnvironmentId,
}));
vi.mock(import("~/browser/browserRecording"), async (original) => ({
  ...(await original()),
  findActiveBrowserRecordingRuntimeTabId: () => mocks.recordingRuntimeTabId,
  useActiveBrowserRecordingTabIds: () => mocks.recordingTabIds,
}));
vi.mock(import("~/components/ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: mocks.toast } };
});
vi.mock(import("./useDiscoveredLocalServers"), async (original) => ({
  ...(await original()),
  useDiscoveredLocalServers: () => mocks.servers,
}));
vi.mock(import("./usePreviewSession"), async (original) => ({
  ...(await original()),
  usePreviewSession: () => {},
}));

import { useComposerDraftStore } from "~/composerDraftStore";
import { useBrowserPointerStore } from "~/browser/browserPointerStore";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useEnvironmentSupportsServerBrowser: () => false,
}));
vi.mock(import("~/state/preview"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const denied = Atom.make(false);
  return {
    ...(await original()),
    previewEnvironment: {
      open: {},
      close: {},
      resize: {},
      resolveUrl: {
        id: "resolveUrl",
        permissionAtom: () => (mocks.canResolveUrl ? allowed : denied),
      },
    } as never,
  };
});

vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { id?: string } | undefined) =>
    command?.id === "resolveUrl" ? mocks.resolveUrl : vi.fn()) as never,
}));

vi.mock(import("./openPreviewSession"), async (original) => ({
  ...(await original()),
  openPreviewSession: mocks.openPreviewSession,
}));
vi.mock(import("./closePreviewSession"), async (original) => ({
  ...(await original()),
  closePreviewSession: mocks.closePreviewSession,
}));

import { useRightPanelStore } from "~/rightPanelStore";
import { dispatchPreviewAction } from "./previewActionBus";
import { PreviewView } from "./PreviewView";

const TEST_THREAD_REF = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
} as const;
const TEST_RUNTIME_TAB_ID = previewRuntimeTabId(TEST_THREAD_REF, null, "tab-1");

const roots: Root[] = [];
let root: Root;

async function render(node: ReactNode) {
  await act(async () => root.render(node));
}

function view(onSendAnnotation?: ComponentProps<typeof PreviewView>["onSendAnnotation"]) {
  return (
    <PreviewView
      threadRef={TEST_THREAD_REF}
      tabId="tab-1"
      visible
      {...(onSendAnnotation ? { onSendAnnotation } : {})}
    />
  );
}

function annotation(id: string, screenshot: unknown = null) {
  return {
    id,
    pageUrl: "https://example.com/dashboard",
    pageTitle: "Dashboard",
    comment: "Tighten this spacing",
    elements: [],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot,
    createdAt: "2026-07-27T00:00:00.000Z",
  };
}

async function submitAddress(text: string) {
  const input = page.getByPlaceholder("Search or enter URL");
  await userEvent.click(input);
  await userEvent.fill(input, text);
  await userEvent.keyboard("{Enter}");
}

function hasCursor() {
  return document.querySelector("svg.lucide-mouse-pointer2") !== null;
}

describe("PreviewView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.supportsCodespaces = false;
    mocks.sourceUrl = undefined;
    mocks.canResolveUrl = true;
    mocks.primaryEnvironmentId = EnvironmentId.make("environment-1");
    mocks.openPreviewSession.mockReset();
    mocks.closePreviewSession.mockReset();
    useRightPanelStore.setState({ openBrowser: mocks.openBrowser });
    mocks.readEnvironmentScope.mockReset().mockReturnValue(true);
    mocks.setAnnotationSendEnabled.mockReset().mockResolvedValue(undefined);
    mocks.pickElement.mockReset();
    mocks.pictureInPicture = false;
    mocks.showEmptyState = false;
    mocks.loading = false;
    mocks.serverEpoch = null;
    mocks.servers = [];
    mocks.recordingTabIds = new Set();
    mocks.recordingRuntimeTabId = null;
    useComposerDraftStore.setState({
      addPreviewAnnotation: mocks.addPreviewAnnotation,
      addImage: mocks.addImage,
    });
    usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
    useBrowserPointerStore.setState({ byTabId: {} });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    roots.push(root);
  });

  afterEach(async () => {
    for (const each of roots.splice(0)) await act(async () => each.unmount());
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it("does not resolve or navigate when the destination preview grant is missing", async () => {
    mocks.supportsCodespaces = true;
    mocks.canResolveUrl = false;
    await render(view());
    await expect.element(page.getByPlaceholder("Search or enter URL")).toBeDisabled();
    expect(mocks.resolveUrl).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.openPreviewSession).not.toHaveBeenCalled();
  });
  it("resolves workspace URLs only when the host advertises Codespaces", async () => {
    mocks.supportsCodespaces = true;
    await render(view());
    await submitAddress("localhost:3000/app");
    expect(mocks.navigate).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID, "http://localhost:14528/app");
    expect(mocks.resolveUrl).toHaveBeenCalledWith({
      environmentId: TEST_THREAD_REF.environmentId,
      input: { threadId: TEST_THREAD_REF.threadId, url: "http://localhost:3000/app" },
    });
    expect(mocks.rememberPreviewUrl).toHaveBeenCalledWith(
      TEST_THREAD_REF,
      "http://localhost:3000/app",
    );
  });

  it.each(["button", "desktop shortcut", "hard reload"])(
    "%s refresh uses the application address after a forwarded URL expires",
    async (trigger) => {
      mocks.supportsCodespaces = true;
      mocks.sourceUrl = "http://localhost:4173/page";
      mocks.resolveUrl.mockResolvedValueOnce({
        _tag: "Success",
        value: "http://127.0.0.1:61000/page",
      });
      await render(view());
      if (trigger === "button") {
        await userEvent.click(page.getByRole("button", { name: "Refresh", exact: true }));
      } else if (trigger === "desktop shortcut") {
        await act(async () => dispatchPreviewAction("refresh"));
      } else {
        await userEvent.click(page.getByRole("button", { name: "Preview menu" }));
        await userEvent.click(page.getByRole("menuitem", { name: "Hard reload" }));
      }
      expect(mocks.resolveUrl).toHaveBeenCalledWith({
        environmentId: TEST_THREAD_REF.environmentId,
        input: { threadId: TEST_THREAD_REF.threadId, url: mocks.sourceUrl },
      });
      expect(mocks.navigate).toHaveBeenCalledWith(
        TEST_RUNTIME_TAB_ID,
        "http://127.0.0.1:61000/page",
      );
      expect(mocks.refresh).not.toHaveBeenCalled();
    },
  );

  it.each(["localhost:3000/app", "http://localhost:14528/app"])(
    "opens %s in the remote host browser, then replaces the desktop tab",
    async (requestedUrl) => {
      mocks.supportsCodespaces = true;
      mocks.primaryEnvironmentId = EnvironmentId.make("local-host");
      mocks.openPreviewSession.mockResolvedValue({ _tag: "Success", value: { tabId: "host-tab" } });
      await render(view());
      await submitAddress(requestedUrl);
      expect(mocks.navigate).not.toHaveBeenCalled();
      expect(mocks.openPreviewSession).toHaveBeenCalledWith(
        expect.objectContaining({
          threadRef: TEST_THREAD_REF,
          url: requestedUrl.startsWith("http") ? requestedUrl : "http://" + requestedUrl,
          runtime: "server",
        }),
      );
      expect(mocks.openBrowser).toHaveBeenCalledWith(TEST_THREAD_REF, "host-tab");
      expect(mocks.closePreviewSession).toHaveBeenCalledWith(
        expect.objectContaining({ tabId: "tab-1" }),
      );
    },
  );
  it("keeps an unchanged external URL in the desktop browser of a remote host", async () => {
    mocks.supportsCodespaces = true;
    mocks.primaryEnvironmentId = EnvironmentId.make("local-host");
    mocks.resolveUrl.mockResolvedValueOnce({ _tag: "Success", value: "https://example.com/" });
    await render(view());
    await submitAddress("https://example.com/");
    expect(mocks.navigate).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID, "https://example.com/");
    expect(mocks.openPreviewSession).not.toHaveBeenCalled();
  });
  it("keeps bridge navigation when a custom host returns a non-absolute URL", async () => {
    mocks.supportsCodespaces = true;
    mocks.primaryEnvironmentId = EnvironmentId.make("local-host");
    mocks.resolveUrl.mockResolvedValueOnce({ _tag: "Success", value: "/app" });
    await render(view());
    await submitAddress("localhost:3000/app");
    expect(mocks.navigate).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID, "/app");
    expect(mocks.openPreviewSession).not.toHaveBeenCalled();
  });

  it("shows the cursor in a replacement browser while the old instance still records", async () => {
    mocks.recordingTabIds.add(TEST_RUNTIME_TAB_ID);
    mocks.recordingRuntimeTabId = TEST_RUNTIME_TAB_ID;
    const replacementTabId = previewRuntimeTabId(TEST_THREAD_REF, "replacement-server", "tab-1");
    useBrowserPointerStore.setState({
      byTabId: Object.fromEntries(
        [TEST_RUNTIME_TAB_ID, replacementTabId].map((tabId) => [
          tabId,
          { tabId, phase: "move", x: 10, y: 10, sequence: 1, createdAt: "2026-07-27T00:00:00Z" },
        ]),
      ),
    });
    await render(view());
    expect(hasCursor()).toBe(false);
    mocks.serverEpoch = "replacement-server";
    await render(view());
    expect(hasCursor()).toBe(true);
    expect(mocks.recordingTabIds.has(TEST_RUNTIME_TAB_ID)).toBe(true);
  });

  it("does not rerender while loading time passes", async () => {
    vi.useFakeTimers();
    mocks.loading = true;
    const onRender = vi.fn();
    await render(
      <Profiler id="preview" onRender={onRender}>
        {view()}
      </Profiler>,
    );
    const initialRenderCount = onRender.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(onRender).toHaveBeenCalledTimes(initialRenderCount);
  });

  it.each([
    [
      "https://localhost:8000/dashboard?mode=test#top",
      "https://localhost:8000/dashboard?mode=test#top",
    ],
    ["localhost:5173/app", "http://localhost:5173/app"],
  ])(
    "preserves a direct localhost URL %s in a WSL environment and records it",
    async (submitted, expected) => {
      await render(view());
      await submitAddress(submitted);
      await vi.waitFor(() =>
        expect(mocks.navigate).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID, expected),
      );
      expect(mocks.rememberPreviewUrl).toHaveBeenCalledWith(TEST_THREAD_REF, expected);
      expect(mocks.recordVisitForThread).toHaveBeenCalledWith(TEST_THREAD_REF, expected);
    },
  );

  it("maps an empty-state localhost server onto the WSL host", async () => {
    mocks.showEmptyState = true;
    mocks.servers = [
      {
        host: "localhost",
        port: 5173,
        url: "http://localhost:5173/app?mode=test#top",
        requestedUrl: "http://localhost:5173/app?mode=test#top",
        processName: "vite",
        pid: 1,
        terminal: null,
        source: "scanner",
      } as unknown as PreviewableServer,
    ];
    await render(view());
    await userEvent.click(page.getByRole("button", { name: /vite/ }));

    await vi.waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith(
        TEST_RUNTIME_TAB_ID,
        "http://172.25.85.75:5173/app?mode=test#top",
      ),
    );
    expect(mocks.rememberPreviewUrl).toHaveBeenCalledWith(
      TEST_THREAD_REF,
      "http://172.25.85.75:5173/app?mode=test#top",
    );
    // History keys off the requested loopback URL, which stays stable across hosts.
    await vi.waitFor(() =>
      expect(mocks.recordVisitForThread).toHaveBeenCalledWith(
        TEST_THREAD_REF,
        "http://localhost:5173/app?mode=test#top",
      ),
    );
  });

  it("opens and closes a thread-scoped floating preview for the active tab", async () => {
    await render(view());
    await userEvent.click(page.getByRole("button", { name: "Float preview over chat" }));
    expect(usePreviewMiniPlayerStore.getState().byThreadKey).toMatchObject({
      "environment-1:thread-1": { source: { kind: "browser", tabId: "tab-1" } },
    });
    const closeButton = page.getByRole("button", { name: "Close floating preview" });
    await expect.element(closeButton).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(closeButton);
    expect(usePreviewMiniPlayerStore.getState().byThreadKey).toEqual({});
  });

  it("keeps the native preview window as a secondary menu action", async () => {
    await render(view());
    await userEvent.click(page.getByRole("button", { name: "Preview menu" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Open separate preview window" }));
    await vi.waitFor(() =>
      expect(mocks.openPictureInPicture).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID),
    );
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());

    mocks.pictureInPicture = true;
    await render(view());
    await userEvent.click(page.getByRole("button", { name: "Preview menu" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Close separate preview window" }));
    await vi.waitFor(() =>
      expect(mocks.closePictureInPicture).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID),
    );
  });

  it("forwards Cmd/Ctrl+Enter annotations to the composer send path", async () => {
    const picked = annotation("annotation-1");
    const onSendAnnotation = vi.fn();
    mocks.pickElement.mockResolvedValue({ annotation: picked, submission: "send" });
    await render(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));

    await vi.waitFor(() => expect(onSendAnnotation).toHaveBeenCalledWith(picked, null));
    expect(mocks.addPreviewAnnotation).toHaveBeenCalledWith(TEST_THREAD_REF, picked);
  });

  it("retains the annotation locally when its own environment loses access during capture", async () => {
    const picked = annotation("annotation-revoked");
    const onSendAnnotation = vi.fn();
    let submitPick: (() => void) | undefined;
    mocks.pickElement.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          submitPick = () => resolve({ annotation: picked, submission: "send" });
        }),
    );
    await render(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));
    await vi.waitFor(() => expect(submitPick).toBeDefined());
    expect(mocks.setAnnotationSendEnabled).toHaveBeenLastCalledWith(TEST_RUNTIME_TAB_ID, true);

    mocks.readEnvironmentScope.mockImplementation(
      (environmentId?: unknown) => environmentId !== TEST_THREAD_REF.environmentId,
    );
    await render(view(onSendAnnotation));
    expect(mocks.setAnnotationSendEnabled).toHaveBeenLastCalledWith(TEST_RUNTIME_TAB_ID, false);
    await act(async () => submitPick!());
    await vi.waitFor(() =>
      expect(mocks.addPreviewAnnotation).toHaveBeenCalledWith(TEST_THREAD_REF, picked),
    );
    expect(onSendAnnotation).not.toHaveBeenCalled();

    mocks.readEnvironmentScope.mockReturnValue(true);
    mocks.pickElement.mockResolvedValue({ annotation: picked, submission: "send" });
    await render(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));
    await vi.waitFor(() => expect(onSendAnnotation).toHaveBeenCalledWith(picked, null));
    expect(mocks.setAnnotationSendEnabled).toHaveBeenLastCalledWith(TEST_RUNTIME_TAB_ID, true);
  });

  it("does not reopen a cancelled picker after the permission update finishes", async () => {
    let finishUpdate: (() => void) | undefined;
    mocks.setAnnotationSendEnabled.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishUpdate = resolve;
        }),
    );
    await render(view());
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));
    await vi.waitFor(() => expect(finishUpdate).toBeDefined());
    expect(mocks.pickElement).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Cancel annotation" }));
    expect(mocks.cancelPickElement).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID);
    await act(async () => finishUpdate!());
    expect(mocks.pickElement).not.toHaveBeenCalled();
    expect(mocks.addPreviewAnnotation).not.toHaveBeenCalled();
  });

  it("warns when main dropped the crop before handing over the pick", async () => {
    const picked = annotation("annotation-3");
    const onSendAnnotation = vi.fn();
    mocks.pickElement.mockResolvedValue({
      annotation: picked,
      submission: "send",
      screenshotFailed: true,
    });
    await render(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));

    await vi.waitFor(() => expect(onSendAnnotation).toHaveBeenCalledWith(picked, null));
    expect(mocks.toast).toHaveBeenCalledOnce();
  });

  it("still sends annotation text when the picked element's crop is malformed", async () => {
    const picked = annotation("annotation-2", {
      dataUrl: "data:image/png;base64,%%%",
      width: 10,
      height: 10,
      cropRect: { x: 0, y: 0, width: 10, height: 10 },
    });
    const onSendAnnotation = vi.fn();
    mocks.pickElement.mockResolvedValue({ annotation: picked, submission: "send" });
    await render(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));

    const sent = { ...picked, screenshot: null };
    await vi.waitFor(() => expect(onSendAnnotation).toHaveBeenCalledWith(sent, null));
    expect(mocks.addPreviewAnnotation).toHaveBeenCalledWith(TEST_THREAD_REF, sent);
    expect(mocks.addImage).not.toHaveBeenCalled();
  });
});
