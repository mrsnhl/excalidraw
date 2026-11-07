import {
  findUnknownVariableRanges,
  hasVariablePlaceholders,
  inlineVariableReferences,
  isValidVariableName,
  normalizeVariableName,
  parseVariableReferences,
  renameVariableReferences,
  resolveVariables,
  VARIABLE_NAME_MAX_LENGTH,
} from "./variables";

const vars = new Map([
  ["price", "$12"],
  ["qty", "3"],
  ["nested", "{{price}}"],
  ["multi", "a\nb"],
]);

describe("variables", () => {
  it("resolves known names and keeps unknown ones", () => {
    expect(resolveVariables("{{price}} x {{ qty }}", vars)).toBe("$12 x 3");
    expect(resolveVariables("{{missing}} {{price}}", vars)).toBe(
      "{{missing}} $12",
    );
    expect(resolveVariables("{{price}}{{price}}", vars)).toBe("$12$12");
  });

  it("does not re-scan values", () => {
    expect(resolveVariables("{{nested}}", vars)).toBe("{{price}}");
  });

  it("keeps newlines in values", () => {
    expect(resolveVariables("{{multi}}", vars)).toBe("a\nb");
  });

  it("returns text unchanged for null or empty maps", () => {
    const text = "{{price}}";
    expect(resolveVariables(text, null)).toBe(text);
    expect(resolveVariables(text, undefined)).toBe(text);
    expect(resolveVariables(text, new Map())).toBe(text);
  });

  it("detects and parses placeholders", () => {
    expect(hasVariablePlaceholders("no vars")).toBe(false);
    expect(hasVariablePlaceholders("{{ 1bad }}")).toBe(false);
    expect(hasVariablePlaceholders("{{ok}}")).toBe(true);
    expect(parseVariableReferences("{{a}} {{b}} {{ a }}")).toEqual(["a", "b"]);
  });

  it("renames references with whitespace variants", () => {
    expect(renameVariableReferences("{{a}} {{ a }} {{ab}}", "a", "z")).toBe(
      "{{z}} {{z}} {{ab}}",
    );
    const same = "{{b}}";
    expect(renameVariableReferences(same, "a", "z")).toBe(same);
  });

  it("inlines references", () => {
    expect(inlineVariableReferences("{{a}}-{{b}}", "a", "1")).toBe("1-{{b}}");
  });

  it("finds unknown ranges", () => {
    expect(findUnknownVariableRanges("x {{price}} {{nope}}", vars)).toEqual([
      { start: 12, end: 20, name: "nope" },
    ]);
  });

  it("validates names", () => {
    expect(isValidVariableName("price")).toBe(true);
    expect(isValidVariableName("_a-1")).toBe(true);
    expect(isValidVariableName("prix_€")).toBe(false);
    expect(isValidVariableName("größe")).toBe(true);
    expect(isValidVariableName("1a")).toBe(false);
    expect(isValidVariableName("")).toBe(false);
    expect(isValidVariableName("a".repeat(VARIABLE_NAME_MAX_LENGTH + 1))).toBe(
      false,
    );
    expect(normalizeVariableName("  unit price ")).toBe("unit_price");
  });
});
