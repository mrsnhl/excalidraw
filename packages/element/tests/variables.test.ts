import {
  buildVariableMap,
  countVariableUsage,
  getNonDeletedElements,
  isInvisiblySmallElement,
  mutateElement,
  newElementWith,
  newTextElement,
  newVariableElement,
  refreshVariableDependents,
  rewriteVariableTexts,
  Scene,
  syncInvalidIndices,
} from "../src";

import type { ExcalidrawElement, ExcalidrawTextElement } from "../src/types";

const variable = (
  name: string,
  value: string,
  opts: { id?: string; index?: string } = {},
) =>
  Object.assign(newVariableElement({ name, value }), {
    ...(opts.id ? { id: opts.id } : {}),
    index: (opts.index ?? "a0") as ExcalidrawElement["index"],
  });

const deletedCopy = <T extends ExcalidrawElement>(element: T) =>
  ({ ...element, isDeleted: true } as T);

const text = (originalText: string, displayed = originalText) =>
  newTextElement({ x: 0, y: 0, text: displayed, originalText });

describe("buildVariableMap", () => {
  it("maps names to values", () => {
    const { map } = buildVariableMap([variable("a", "1"), variable("b", "2")]);
    expect(Object.fromEntries(map)).toEqual({ a: "1", b: "2" });
  });

  it("ignores deleted variables and other elements", () => {
    const deleted = deletedCopy(variable("gone", "x"));
    const { map } = buildVariableMap([
      deleted,
      text("{{a}}"),
      variable("a", "1"),
    ]);
    expect([...map.keys()]).toEqual(["a"]);
  });

  it("picks the lowest fractional index for duplicate names", () => {
    const { map } = buildVariableMap([
      variable("a", "late", { id: "1", index: "a5" }),
      variable("a", "early", { id: "2", index: "a1" }),
    ]);
    expect(map.get("a")).toBe("early");
  });

  it("breaks index ties with the id", () => {
    const { map } = buildVariableMap([
      variable("a", "from-b", { id: "b" }),
      variable("a", "from-a", { id: "a" }),
    ]);
    expect(map.get("a")).toBe("from-a");
  });

  it("changes the version when a variable changes", () => {
    const element = variable("a", "1");
    const before = buildVariableMap([element]).version;
    const after = buildVariableMap([
      newElementWith(element, { value: "2" }),
    ]).version;
    expect(after).not.toBe(before);
  });
});

describe("Scene variables", () => {
  it("keeps variables out of the visual elements, but not out of the full list", () => {
    const v = variable("a", "1");
    const t = text("hi");
    const scene = new Scene(syncInvalidIndices([v, t]));
    expect(scene.getNonDeletedElements()).toEqual([t]);
    expect(scene.getNonDeletedElementsMap().has(v.id)).toBe(false);
    expect(scene.getElementsIncludingDeleted()).toContain(v);
    expect(getNonDeletedElements([v, t])).toEqual([t]);
  });

  it("memoizes getVariables() and refreshes it after a mutation", () => {
    const v = variable("a", "1");
    const scene = new Scene(syncInvalidIndices([v]));
    const first = scene.getVariables();
    expect(scene.getVariables()).toBe(first);
    expect(first.map.get("a")).toBe("1");

    mutateElement(v, scene.getElementsMapIncludingDeleted(), { value: "2" });
    const second = scene.getVariables();
    expect(second).not.toBe(first);
    expect(second.version).not.toBe(first.version);
    expect(second.map.get("a")).toBe("2");
  });

  it("returns exactly { map, version }", () => {
    expect(
      Object.keys(
        new Scene(syncInvalidIndices([variable("a", "1")])).getVariables(),
      ).sort(),
    ).toEqual(["map", "version"]);
  });

  it("does not consider variables invisibly small", () => {
    expect(isInvisiblySmallElement(variable("a", "1"))).toBe(false);
  });
});

describe("countVariableUsage / rewriteVariableTexts", () => {
  it("counts an element once per name, including unknown names", () => {
    const usage = countVariableUsage([
      text("{{a}} {{a}} {{b}}"),
      text("{{a}}"),
      deletedCopy(text("{{a}}")),
    ]);
    expect(usage.get("a")).toBe(2);
    expect(usage.get("b")).toBe(1);
  });

  it("rewrites only the texts that change", () => {
    const withRef = text("{{a}}");
    const without = text("plain");
    const next = rewriteVariableTexts([withRef, without], (value) =>
      value.replace("{{a}}", "{{b}}"),
    );
    expect((next[0] as ExcalidrawTextElement).originalText).toBe("{{b}}");
    expect(next[1]).toBe(without);
    expect(rewriteVariableTexts([without], (value) => value)).toEqual([
      without,
    ]);
  });
});

describe("refreshVariableDependents", () => {
  it("resolves the displayed text and keeps the raw one", () => {
    const elements = [variable("price", "$12"), text("{{price}} each")];
    const next = refreshVariableDependents(elements);
    const refreshed = next[1] as ExcalidrawTextElement;
    expect(refreshed.text).toBe("$12 each");
    expect(refreshed.originalText).toBe("{{price}} each");
    expect(refreshed.width).toBeGreaterThan(0);
  });

  it("returns the same array when nothing is stale", () => {
    const elements = [variable("price", "$12"), text("{{price}} each")];
    const once = refreshVariableDependents(elements);
    expect(refreshVariableDependents(once)).toBe(once);
    expect(refreshVariableDependents([text("no placeholders")])).toHaveLength(
      1,
    );
  });

  it("follows a value change and leaves unknown names raw", () => {
    const price = variable("price", "$12");
    const first = refreshVariableDependents([
      price,
      text("{{price}} {{nope}}"),
    ]);
    expect((first[1] as ExcalidrawTextElement).text).toBe("$12 {{nope}}");

    const second = refreshVariableDependents([
      newElementWith(price, { value: "$99" }),
      first[1],
    ]);
    expect((second[1] as ExcalidrawTextElement).text).toBe("$99 {{nope}}");
    // the variable isn't touched
    expect(second[0]).not.toBe(first[0]);
  });

  it("shows the raw placeholder once the variable is deleted", () => {
    const price = variable("price", "$12");
    const resolved = refreshVariableDependents([price, text("{{price}}")]);
    const next = refreshVariableDependents([deletedCopy(price), resolved[1]]);
    expect((next[1] as ExcalidrawTextElement).text).toBe("{{price}}");
  });

  it("skips the given ids", () => {
    const t = text("{{a}}");
    const elements = [variable("a", "1"), t];
    const next = refreshVariableDependents(elements, {
      skipIds: new Set([t.id]),
    });
    expect(next).toBe(elements);
  });

  it("does not mutate its input", () => {
    const t = text("{{a}}");
    refreshVariableDependents([variable("a", "1"), t]);
    expect(t.text).toBe("{{a}}");
  });
});
