import { clipboard } from "electron";

// Electron 43 exposes synchronous format readers rather than ClipboardItem reads.
export const readPreviewClipboardFormats = () =>
  clipboard
    .availableFormats()
    .filter((type) => !type.startsWith("electron "))
    .map((type) => {
      let data: string;
      switch (type) {
        case "text/plain":
          data = clipboard.readText();
          break;
        case "text/html":
          data = clipboard.readHTML();
          break;
        case "text/rtf":
          data = clipboard.readRTF();
          break;
        case "image/png":
          data = clipboard.readImage().toPNG().toString("base64");
          break;
        default:
          data = clipboard.readBuffer(type).toString(type.startsWith("text/") ? "utf8" : "base64");
      }
      return { type, data };
    });
