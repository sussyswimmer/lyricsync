import { describe, expect, it } from "vitest";
import { RETIRED_STYLES, STYLES } from "../src/core/songlook";
import { migrateStylePin, parseStylePin, STYLE_PIN_KEY, takeStylePin } from "../src/overlay/pin";

/** A web storage holding one value, remembering what was removed. */
function storageWith(value: string | null): Pick<Storage, "getItem" | "removeItem"> & { removed: string[] } {
  let held = value;
  const removed: string[] = [];
  return {
    removed,
    getItem: (key) => (key === STYLE_PIN_KEY ? held : null),
    removeItem: (key) => {
      removed.push(key);
      if (key === STYLE_PIN_KEY) held = null;
    },
  };
}

describe("the 0.3.0 style pin, moved into Settings › Style", () => {
  it("reads every style Settings offers", () => {
    for (const style of STYLES) expect(parseStylePin(style)).toBe(style);
  });

  it("reads a pin of a retired style, saved before it was retired, as Auto", () => {
    for (const style of RETIRED_STYLES) expect(parseStylePin(style), style).toBeNull();
  });

  it("reads anything else as Auto", () => {
    for (const value of [null, undefined, "", "auto", "Slant", 3, {}]) expect(parseStylePin(value)).toBeNull();
  });

  it("takes the pin out of storage, once", () => {
    const storage = storageWith("slant");
    expect(takeStylePin(storage)).toBe("slant");
    expect(storage.removed).toEqual([STYLE_PIN_KEY]);
    expect(takeStylePin(storage)).toBeNull();
    expect(storage.removed).toEqual([STYLE_PIN_KEY]);
  });

  it("leaves a storage with no pin alone, and copes without one", () => {
    const storage = storageWith(null);
    expect(takeStylePin(storage)).toBeNull();
    expect(storage.removed).toEqual([]);
    expect(takeStylePin(null)).toBeNull();
    expect(
      takeStylePin({
        getItem: () => {
          throw new Error("blocked");
        },
        removeItem: () => undefined,
      }),
    ).toBeNull();
  });

  it("saves the pin as the Style setting, and a retired pin as nothing", async () => {
    const patches: unknown[] = [];
    const bridge = { invoke: async (_cmd: string, args: unknown) => (patches.push(args), undefined) };
    await migrateStylePin(bridge as never, storageWith("pop"));
    expect(patches).toEqual([{ patch: { style: "pop" } }]);
    await migrateStylePin(bridge as never, storageWith("arc"));
    await migrateStylePin(bridge as never, storageWith(null));
    expect(patches).toHaveLength(1);
  });

  it("loses the pin quietly when the core can't take it", async () => {
    const bridge = { invoke: async () => Promise.reject(new Error("unknown field style")) };
    const storage = storageWith("tape");
    await expect(migrateStylePin(bridge as never, storage)).resolves.toBeUndefined();
    expect(storage.removed).toEqual([STYLE_PIN_KEY]);
  });
});
