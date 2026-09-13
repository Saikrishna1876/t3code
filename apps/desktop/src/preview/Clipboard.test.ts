import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { clipboard } from "electron";
import { readPreviewClipboardFormats } from "./Clipboard.ts";

vi.mock("electron", () => ({
  clipboard: {
    availableFormats: vi.fn(),
    readText: vi.fn(),
    readHTML: vi.fn(),
    readRTF: vi.fn(),
    readImage: vi.fn(),
    readBuffer: vi.fn(),
  },
}));

beforeEach(() => vi.resetAllMocks());

describe("readPreviewClipboardFormats", () => {
  it("preserves text and binary paste data while excluding Electron metadata", () => {
    vi.mocked(clipboard.availableFormats).mockReturnValue([
      "text/plain",
      "text/html",
      "text/rtf",
      "image/png",
      "text/custom",
      "application/custom",
      "electron internal",
    ]);
    vi.mocked(clipboard.readText).mockReturnValue("Hello 日本語");
    vi.mocked(clipboard.readHTML).mockReturnValue("<b>Hello</b>");
    vi.mocked(clipboard.readRTF).mockReturnValue("{\\rtf1 Hello}");
    vi.mocked(clipboard.readImage).mockReturnValue({
      toPNG: () => Buffer.from([137, 80, 78, 71]),
    } as Electron.NativeImage);
    vi.mocked(clipboard.readBuffer).mockImplementation((type) =>
      type === "text/custom" ? Buffer.from("custom 日本語") : Buffer.from([0, 255]),
    );
    expect(readPreviewClipboardFormats()).toEqual([
      { type: "text/plain", data: "Hello 日本語" },
      { type: "text/html", data: "<b>Hello</b>" },
      { type: "text/rtf", data: "{\\rtf1 Hello}" },
      { type: "image/png", data: "iVBORw==" },
      { type: "text/custom", data: "custom 日本語" },
      { type: "application/custom", data: "AP8=" },
    ]);
  });

  it("returns no formats for an empty clipboard", () => {
    vi.mocked(clipboard.availableFormats).mockReturnValue([]);
    expect(readPreviewClipboardFormats()).toEqual([]);
  });

  it("propagates synchronous read failures to the operation error wrapper", () => {
    vi.mocked(clipboard.availableFormats).mockReturnValue(["text/plain"]);
    const error = new Error("clipboard unavailable");
    vi.mocked(clipboard.readText).mockImplementation(() => {
      throw error;
    });
    expect(readPreviewClipboardFormats).toThrow(error);
  });
});
