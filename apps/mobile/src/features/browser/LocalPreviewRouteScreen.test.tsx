import type { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode, Ref } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

type ErrorPayload = {
  readonly url: string;
  readonly unsupported: boolean;
  readonly description: string;
};

type NavigationPayload = {
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
};

const mocks = vi.hoisted(() => ({
  loaded: [] as string[],
  tunnelWebViewProps: null as null | {
    onLoadError: (failure: ErrorPayload) => void;
    onNavigationChange: (navigation: NavigationPayload) => void;
  },
  loadUrl: vi.fn<(url: string) => Promise<void>>(),
  submit: null as null | ((value: string) => void),
  navigation: { goBack: vi.fn() },
}));

vi.mock("@react-navigation/native", () => ({ useNavigation: () => mocks.navigation }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: ({ title, detail }: { title: string; detail: string }) => (
    <div>
      {title}
      {detail}
    </div>
  ),
}));
vi.mock("../../i18n/messages", () => ({ m: (value: string) => value }));
vi.mock("../../state/entities", () => ({ useEnvironmentPreviewTunnelOff: () => false }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ presentationById: new Map() }),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: { "--color-sheet-solid": "#fff" } }),
}));
vi.mock("./BrowserBar", async () => {
  const { useEffect } = await import("react");
  return {
    BrowserChrome: ({
      children,
      bar,
    }: {
      children: (args: { topInset: number; onScrollDirection: () => void }) => ReactNode;
      bar: { onSubmit: (value: string) => void };
    }) => {
      useEffect(() => {
        mocks.submit = bar.onSubmit;
      }, [bar.onSubmit]);
      return <div>{children({ topInset: 0, onScrollDirection: vi.fn() })}</div>;
    },
  };
});
vi.mock("./TunnelWebView", async () => {
  const { forwardRef, useEffect, useImperativeHandle } = await import("react");
  return {
    TunnelWebView: forwardRef(
      (
        props: {
          url: string;
          onLoadError: (failure: ErrorPayload) => void;
          onNavigationChange: (navigation: NavigationPayload) => void;
        },
        ref: Ref<unknown>,
      ) => {
        useEffect(() => {
          mocks.tunnelWebViewProps = props;
          mocks.loaded.push(props.url);
        }, [props]);
        useImperativeHandle(ref, () => ({
          loadUrl: mocks.loadUrl,
          goBack: vi.fn(() => Promise.resolve()),
          goForward: vi.fn(() => Promise.resolve()),
          reload: vi.fn(() => Promise.resolve()),
        }));
        return <div />;
      },
    ),
  };
});

import { LocalPreviewScreen, LocalPreviewRouteScreen } from "./LocalPreviewRouteScreen";

const UNSUPPORTED_TITLE = "This device can't open localhost pages";

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.tunnelWebViewProps = null;
  mocks.submit = null;
  mocks.loadUrl = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      <LocalPreviewScreen
        environmentId={"env-1" as EnvironmentId}
        url="http://localhost:5173/"
        onClose={vi.fn()}
      />,
    ),
  );
  return {
    container,
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

function refuseHttpsLoopback() {
  act(() =>
    mocks.tunnelWebViewProps!.onLoadError({
      url: "",
      unsupported: true,
      description: "https://localhost:8443/",
    }),
  );
}

describe("LocalPreviewScreen unsupported overlay", () => {
  it("keeps device-wide advice until the submitted address actually navigates", () => {
    using view = setup();
    refuseHttpsLoopback();
    expect(view.container.textContent).toContain(UNSUPPORTED_TITLE);

    act(() => mocks.submit!("http://localhost:3000/"));

    expect(view.container.textContent).toContain(UNSUPPORTED_TITLE);
    expect(mocks.loadUrl).toHaveBeenCalledWith("http://localhost:3000/");

    act(() =>
      mocks.tunnelWebViewProps!.onNavigationChange({
        url: "http://localhost:3000/",
        title: "",
        loading: true,
        canGoBack: false,
        canGoForward: false,
      }),
    );

    expect(view.container.textContent).not.toContain(UNSUPPORTED_TITLE);
  });

  it("clears when the webview starts a supported navigation", () => {
    using view = setup();
    refuseHttpsLoopback();
    expect(view.container.textContent).toContain(UNSUPPORTED_TITLE);

    act(() =>
      mocks.tunnelWebViewProps!.onNavigationChange({
        url: "http://localhost:3000/",
        title: "",
        loading: true,
        canGoBack: false,
        canGoForward: false,
      }),
    );

    expect(view.container.textContent).not.toContain(UNSUPPORTED_TITLE);
  });

  it("keeps the refusal until a navigation actually starts", () => {
    using view = setup();
    refuseHttpsLoopback();

    act(() =>
      mocks.tunnelWebViewProps!.onNavigationChange({
        url: "http://localhost:5173/",
        title: "",
        loading: false,
        canGoBack: false,
        canGoForward: false,
      }),
    );

    expect(view.container.textContent).toContain(UNSUPPORTED_TITLE);
  });
});

it("gives the webview only web addresses from the route, on open and on a later link", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  const show = (url: string) => {
    mocks.loaded.length = 0;
    act(() =>
      root.render(<LocalPreviewRouteScreen route={{ params: { environmentId: "env-1", url } }} />),
    );
    return mocks.loaded.at(-1);
  };

  try {
    expect(show("http://0.0.0.0:5173/app")).toBe("http://localhost:5173/app");
    expect(show("javascript:document.title='x'")).toBe("");
    expect(show("https://example.com/docs")).toBe("https://example.com/docs");
    expect(show("file:///data/local/tmp/a.html")).toBe("");
    expect(show("intent://example.com#Intent;scheme=http;end")).toBe("");
  } finally {
    act(() => root.unmount());
  }
});
