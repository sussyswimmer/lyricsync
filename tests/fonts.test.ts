import { describe, expect, it } from "vitest";
import { cjkLang, FONTS, fontFor, stackFor, type CjkLang } from "../src/overlay/fonts";

/** A stack's families, quotes removed. */
const families = (stack: string): string[] => stack.split(",").map((f) => f.trim().replace(/^"|"$/g, ""));

// Original placeholder sentences, one per script.
const JA = "夜明けの駅で、紙の鳥が待っている";
const ZH_HANS = "灯笼漂过安静的河面，我们说好再见";
const ZH_HANT = "燈籠漂過安靜的河面，我們說好再見";
const KO = "작은 불빛이 창문을 두드려요";

// Regression (cjk-fallback-order): one fixed CJK order for every song set Chinese lyrics' shared Han
// characters in Japanese faces (and simplified-only ones in Chinese faces, so a line mixed the two),
// and Japanese in a Chinese face with the sans fonts.
describe("cjkLang: one language per song", () => {
  it("is Japanese with kana, Korean with Hangul, Chinese with Han alone, null without any", () => {
    expect(cjkLang(JA)).toBe("ja");
    expect(cjkLang("ひらがなだけ")).toBe("ja");
    expect(cjkLang(KO)).toBe("ko");
    expect(cjkLang(ZH_HANS, ["en-US"])).toBe("zh-Hans");
    expect(cjkLang("Paper lanterns over the river")).toBeNull();
    expect(cjkLang("Người ơi, đừng đi")).toBeNull();
    expect(cjkLang("")).toBeNull();
  });

  it("reads mixed songs by their main script", () => {
    // Japanese with English, Korean with a few Han characters, Chinese with a stray の
    expect(cjkLang(`${JA}\nhold on tonight`)).toBe("ja");
    expect(cjkLang(`${KO}\n${KO} 天地`)).toBe("ko");
    expect(cjkLang(`${ZH_HANS.repeat(3)}の`, ["en"])).toBe("zh-Hans");
    // kana and Hangul (mock track 5): Korean faces would take the Japanese line, Japanese ones have no Hangul
    expect(cjkLang(`${JA}\n${ZH_HANS}\n${KO}\n${KO}`)).toBe("ja");
  });

  it("tells Traditional from Simplified Chinese by the text, then by the reader's language", () => {
    expect(cjkLang(ZH_HANT, ["zh-CN"])).toBe("zh-Hant");
    expect(cjkLang(ZH_HANS, ["zh-TW"])).toBe("zh-Hans");
    // characters both write: the reader's first language decides
    const shared = "安静的河面";
    for (const [lang, want] of [
      ["zh-TW", "zh-Hant"],
      ["zh-HK", "zh-Hant"],
      ["zh-Hant-MO", "zh-Hant"],
      ["zh-CN", "zh-Hans"],
      ["zh", "zh-Hans"],
      ["en-GB", "zh-Hans"],
    ] as const)
      expect(cjkLang(shared, [lang]), lang).toBe(want);
    expect(cjkLang(shared, [])).toBe("zh-Hans");
  });
});

describe("stackFor", () => {
  const LANGS: CjkLang[] = ["ja", "zh-Hans", "zh-Hant", "ko"];

  it("puts the song's own CJK families first, after the face and the Latin and system fallbacks", () => {
    const serif = stackFor(fontFor("Fraunces"), "zh-Hans");
    expect(families(serif).slice(0, 4)).toEqual(["Fraunces", "Georgia", "Songti SC", "SimSun"]);
    const sans = stackFor(fontFor("Syne"), "ja");
    expect(families(sans).slice(0, 7)).toEqual(["Syne", "system-ui", "-apple-system", "Segoe UI", "Hiragino Sans", "Yu Gothic", "Meiryo"]);
    expect(families(stackFor(fontFor("Unbounded"), "zh-Hant")).slice(4, 6)).toEqual(["PingFang TC", "Microsoft JhengHei"]);
    expect(families(stackFor(fontFor("Instrument Serif"), "ko")).slice(2, 4)).toEqual(["AppleMyungjo", "Batang"]);
  });

  it("keeps every language's families, each once, and ends with the generic family", () => {
    for (const font of FONTS)
      for (const lang of [...LANGS, null]) {
        const list = families(stackFor(font, lang));
        expect(new Set(list).size, `${font.family} ${lang}`).toBe(list.length);
        for (const name of font.serif ? ["Hiragino Mincho ProN", "Songti SC", "Songti TC", "Batang"] : ["Hiragino Sans", "PingFang SC", "PingFang TC", "Malgun Gothic"])
          expect(list, `${font.family} ${lang}`).toContain(name);
        expect(list[list.length - 1]).toBe(font.serif ? "serif" : "sans-serif");
      }
  });

  it("keeps each face's own Latin fallbacks, and the system stack has no bundled face", () => {
    expect(families(stackFor(fontFor("Caveat"), "ko")).slice(0, 2)).toEqual(["Caveat", "Comic Sans MS"]);
    expect(families(stackFor(fontFor("JetBrains Mono"), null)).slice(0, 4)).toEqual(["JetBrains Mono", "ui-monospace", "Menlo", "Consolas"]);
    expect(families(stackFor(fontFor("System"), "ja"))[0]).toBe("system-ui");
  });

  it("is each face's default stack without a CJK language", () => {
    for (const font of FONTS) expect(font.stack).toBe(stackFor(font, null));
    expect(families(fontFor("Fraunces").stack).slice(0, 6)).toEqual(["Fraunces", "Georgia", "Hiragino Mincho ProN", "Yu Mincho", "Songti SC", "SimSun"]);
  });
});
