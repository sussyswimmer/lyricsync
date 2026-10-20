import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../contract/contract";
import type { SettingsPanel as Panel } from "../src/settings/panel";
import { activeElement, FakeElement, resetDom, stubDom } from "./fake-dom";

/*
 * Settings › Licenses: the footer button opens the third-party notices (THIRD_PARTY_NOTICES.txt) in a
 * modal dialog, loads them once, and gives focus back to the button when the dialog closes.
 */

let SettingsPanel: typeof Panel;
beforeAll(async () => {
  stubDom();
  ({ SettingsPanel } = await import("../src/settings/panel"));
});

/** The modal half of HTMLDialogElement, which the fake DOM leaves out. */
interface FakeDialog {
  open: boolean;
  showModal(): void;
  close(): void;
}

beforeEach(() => {
  resetDom();
  stubDom();
  Object.assign(FakeElement.prototype, {
    open: false,
    showModal(this: FakeElement & FakeDialog): void {
      this.open = true;
    },
    close(this: FakeElement & FakeDialog): void {
      this.open = false;
      this.dispatch("close");
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function mount(licenses: () => Promise<string>) {
  const panel = new SettingsPanel(
    { edit: () => undefined, editNow: () => undefined, setTrackOffset: () => undefined, reset: () => undefined, suspendShortcuts: () => undefined },
    { platform: "mac", licenses },
  );
  panel.render({ settings: structuredClone(DEFAULT_SETTINGS), palette: null, paletteFor: null, artPending: false, track: null, media: null, shortcuts: null, loginError: false, look: { kind: "finding", key: null, demo: false } });
  const root = panel.el as unknown as FakeElement;
  const button = root.all("foot-link")[0] as FakeElement;
  return { root, button };
}

describe("Settings › Licenses", () => {
  it("opens the notices in a labelled modal, loading them once", async () => {
    const load = vi.fn(() => Promise.resolve("Undertone: third-party notices\nfraunces 5.3.0"));
    const { root, button } = mount(load);
    expect(button.textContent).toBe("Licenses");
    expect(root.all("licenses")).toHaveLength(0);

    button.click();
    await settle();
    const dialog = root.one("licenses") as FakeElement & FakeDialog;
    expect(dialog.tagName).toBe("DIALOG");
    expect(dialog.open).toBe(true);
    const title = root.one("licenses-title");
    expect(dialog.attrs.get("aria-labelledby")).toBe(title.id);
    expect(root.one("licenses-text").textContent).toContain("fraunces 5.3.0");

    root.one("licenses-head").all("btn")[0]?.click();
    expect(dialog.open).toBe(false);
    expect(activeElement()).toBe(button);

    button.click();
    await settle();
    expect(root.all("licenses")).toHaveLength(1);
    expect(dialog.open).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("says where the file is when the text can't be loaded", async () => {
    const { root, button } = mount(() => Promise.reject(new Error("chunk missing")));
    button.click();
    await settle();
    expect(root.one("licenses-text").textContent).toContain("THIRD_PARTY_NOTICES.txt");
  });
});
