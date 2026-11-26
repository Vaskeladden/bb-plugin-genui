import { describe, expect, it } from "vitest";
import { repairRequest, unrenderedBlocks } from "./reply-check";

const fence = "```";

describe("unrenderedBlocks", () => {
  it("reports a block that does not compile, numbered among the reply's ui blocks", () => {
    const reply = [
      "Text first.",
      `${fence}ui`,
      `Card("ok", [Text("fine")])`,
      fence,
      "Then a broken one:",
      `${fence}ui`,
      `Card("x", [Text($missing)])`,
      fence,
    ].join("\n");
    const failures = unrenderedBlocks(reply);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^ui block 2:\n1:\d+ error: unknown state `\$missing`/);
  });

  it("accepts a reply whose blocks all compile, and prose with no blocks", () => {
    expect(unrenderedBlocks(`${fence}ui\n$n = 1\nSlider($n, 0, 10)\n${fence}`)).toEqual([]);
    expect(unrenderedBlocks("Just prose.\n\n```ts\nconst x = $y\n```")).toEqual([]);
  });

  it("leaves a reply cut off inside a block alone", () => {
    expect(unrenderedBlocks(`Stopped:\n${fence}ui\nCard("x", [`)).toEqual([]);
  });
});

describe("repairRequest", () => {
  it("names the errors and asks for the whole reply again", () => {
    const text = repairRequest(["ui block 1:\n1:5 error: boom"]);
    expect(text).toContain("A ```ui block in your last reply did not render");
    expect(text).toContain("1:5 error: boom");
    expect(text).toContain("Send your last reply again in full");
  });
});
