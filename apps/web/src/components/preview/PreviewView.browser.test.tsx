import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
} from "@t3tools/contracts";
import { type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";

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
  nativeServerTab: false,
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
            runtime: mocks.nativeServerTab ? "server" : "desktop",
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

vi.mock(import("~/browser/previewRuntime"), async (original) => ({
  ...(await original()),
  useRendersServerTabNatively: () => mocks.nativeServerTab,
}));

vi.mock(import("~/browser/browserViewportActions"), { spy: true });

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

// The mocked modules and stores are shared by the whole file, so every test starts by
// resetting them.
function setup() {
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
  mocks.nativeServerTab = false;
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
}

async function submitAddress(text: string) {
  const input = page.getByPlaceholder("Search or enter URL");
  await userEvent.click(input);
  await userEvent.fill(input, text);
  await userEvent.keyboard("{Enter}");
}

describe("PreviewView", () => {
  it("does not resolve or navigate when the destination preview grant is missing", async () => {
    setup();
    mocks.supportsCodespaces = true;
    mocks.canResolveUrl = false;
    await using _screen = await render(view());
    await expect.element(page.getByPlaceholder("Search or enter URL")).toBeDisabled();
    expect(mocks.resolveUrl).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.openPreviewSession).not.toHaveBeenCalled();
  });
  it("resolves workspace URLs only when the host advertises Codespaces", async () => {
    setup();
    mocks.supportsCodespaces = true;
    await using _screen = await render(view());
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
      setup();
      mocks.supportsCodespaces = true;
      mocks.sourceUrl = "http://localhost:4173/page";
      mocks.resolveUrl.mockResolvedValueOnce({
        _tag: "Success",
        value: "http://127.0.0.1:61000/page",
      });
      await using _screen = await render(view());
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
      setup();
      mocks.supportsCodespaces = true;
      mocks.primaryEnvironmentId = EnvironmentId.make("local-host");
      mocks.openPreviewSession.mockResolvedValue({ _tag: "Success", value: { tabId: "host-tab" } });
      await using _screen = await render(view());
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
    setup();
    mocks.supportsCodespaces = true;
    mocks.primaryEnvironmentId = EnvironmentId.make("local-host");
    mocks.resolveUrl.mockResolvedValueOnce({ _tag: "Success", value: "https://example.com/" });
    await using _screen = await render(view());
    await submitAddress("https://example.com/");
    expect(mocks.navigate).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID, "https://example.com/");
    expect(mocks.openPreviewSession).not.toHaveBeenCalled();
  });
  it("keeps bridge navigation when a custom host returns a non-absolute URL", async () => {
    setup();
    mocks.supportsCodespaces = true;
    mocks.primaryEnvironmentId = EnvironmentId.make("local-host");
    mocks.resolveUrl.mockResolvedValueOnce({ _tag: "Success", value: "/app" });
    await using _screen = await render(view());
    await submitAddress("localhost:3000/app");
    expect(mocks.navigate).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID, "/app");
    expect(mocks.openPreviewSession).not.toHaveBeenCalled();
  });

  it("retains the annotation locally when its own environment loses access during capture", async () => {
    setup();
    const picked = annotation("annotation-revoked");
    const onSendAnnotation = vi.fn();
    let submitPick: (() => void) | undefined;
    mocks.pickElement.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          submitPick = () => resolve({ annotation: picked, submission: "send" });
        }),
    );
    await using screen = await render(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));
    await vi.waitFor(() => expect(submitPick).toBeDefined());
    expect(mocks.setAnnotationSendEnabled).toHaveBeenLastCalledWith(TEST_RUNTIME_TAB_ID, true);

    mocks.readEnvironmentScope.mockImplementation(
      (environmentId?: unknown) => environmentId !== TEST_THREAD_REF.environmentId,
    );
    await screen.rerender(view(onSendAnnotation));
    expect(mocks.setAnnotationSendEnabled).toHaveBeenLastCalledWith(TEST_RUNTIME_TAB_ID, false);
    await act(async () => submitPick!());
    await vi.waitFor(() =>
      expect(mocks.addPreviewAnnotation).toHaveBeenCalledWith(TEST_THREAD_REF, picked),
    );
    expect(onSendAnnotation).not.toHaveBeenCalled();

    mocks.readEnvironmentScope.mockReturnValue(true);
    mocks.pickElement.mockResolvedValue({ annotation: picked, submission: "send" });
    await screen.rerender(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));
    await vi.waitFor(() => expect(onSendAnnotation).toHaveBeenCalledWith(picked, null));
    expect(mocks.setAnnotationSendEnabled).toHaveBeenLastCalledWith(TEST_RUNTIME_TAB_ID, true);
  });

  it("still sends annotation text when the picked element's crop is malformed", async () => {
    setup();
    const picked = annotation("annotation-2", {
      dataUrl: "data:image/png;base64,%%%",
      width: 10,
      height: 10,
      cropRect: { x: 0, y: 0, width: 10, height: 10 },
    });
    const onSendAnnotation = vi.fn();
    mocks.pickElement.mockResolvedValue({ annotation: picked, submission: "send" });
    await using _screen = await render(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));

    const sent = { ...picked, screenshot: null };
    await vi.waitFor(() => expect(onSendAnnotation).toHaveBeenCalledWith(sent, null));
    expect(mocks.addPreviewAnnotation).toHaveBeenCalledWith(TEST_THREAD_REF, sent);
    expect(mocks.addImage).not.toHaveBeenCalled();
  });

  it("focuses the address bar each time the focus-url shortcut fires", async () => {
    setup();
    await using _screen = await render(view());
    const address = page.getByRole("textbox");

    act(() => dispatchPreviewAction("focus-url"));
    await expect.element(address).toHaveFocus();

    (address.element() as HTMLInputElement).blur();
    await expect.element(address).not.toHaveFocus();
    act(() => dispatchPreviewAction("focus-url"));
    await expect.element(address).toHaveFocus();
  });
});
