export type VariableMap = ReadonlyMap<string, string>;

export const VARIABLE_NAME_MAX_LENGTH = 64;

const VARIABLE_NAME_PATTERN = "[\\p{L}_][\\p{L}\\p{N}_-]*";

const VARIABLE_NAME_REGEX = new RegExp(`^${VARIABLE_NAME_PATTERN}$`, "u");

/** creates a fresh global regex so callers never share `lastIndex` state */
const getPlaceholderRegex = () =>
  new RegExp(`\\{\\{\\s*(${VARIABLE_NAME_PATTERN})\\s*\\}\\}`, "gu");

/**
 * Letters or underscore first, then letters, digits, `_` or `-`.
 * Case-sensitive, at most VARIABLE_NAME_MAX_LENGTH characters.
 */
export const isValidVariableName = (name: string): boolean =>
  name.length > 0 &&
  name.length <= VARIABLE_NAME_MAX_LENGTH &&
  VARIABLE_NAME_REGEX.test(name);

/** trims and replaces whitespace runs with `_` */
export const normalizeVariableName = (input: string): string =>
  input.trim().replace(/\s+/g, "_");

/** placeholder syntax: `{{ name }}` (inner whitespace allowed) */
export const hasVariablePlaceholders = (text: string): boolean =>
  text.includes("{{") && getPlaceholderRegex().test(text);

/** unique referenced names, in order of first appearance */
export const parseVariableReferences = (text: string): string[] => {
  if (!text.includes("{{")) {
    return [];
  }
  const names = new Set<string>();
  for (const match of text.matchAll(getPlaceholderRegex())) {
    names.add(match[1]);
  }
  return Array.from(names);
};

/**
 * Replaces `{{name}}` placeholders with their values in a single pass.
 * Unknown names are left as written, and values are not re-scanned
 * (no nesting, so no cycles).
 */
export const resolveVariables = (
  text: string,
  variables: VariableMap | null | undefined,
): string => {
  if (!variables || !variables.size || !text.includes("{{")) {
    return text;
  }
  return text.replace(getPlaceholderRegex(), (placeholder, name: string) => {
    const value = variables.get(name);
    return value === undefined ? placeholder : value;
  });
};

/** replaces every `{{name}}` reference (any inner whitespace) with `replacement` */
const replaceVariableReferences = (
  text: string,
  name: string,
  replacement: string,
): string =>
  text.includes("{{")
    ? text.replace(getPlaceholderRegex(), (placeholder, refName: string) =>
        refName === name ? replacement : placeholder,
      )
    : text;

/** rewrites `{{oldName}}` (any inner whitespace) to `{{newName}}` */
export const renameVariableReferences = (
  text: string,
  oldName: string,
  newName: string,
): string => replaceVariableReferences(text, oldName, `{{${newName}}}`);

/** replaces every `{{name}}` reference with a literal value */
export const inlineVariableReferences = (
  text: string,
  name: string,
  value: string,
): string => replaceVariableReferences(text, name, value);

/**
 * Character ranges of placeholders whose name is not in `variables`.
 * Used by the editor to highlight unknown references.
 */
export const findUnknownVariableRanges = (
  text: string,
  variables: VariableMap | null | undefined,
): { start: number; end: number; name: string }[] => {
  if (!text.includes("{{")) {
    return [];
  }
  const ranges: { start: number; end: number; name: string }[] = [];
  for (const match of text.matchAll(getPlaceholderRegex())) {
    if (!variables?.has(match[1])) {
      ranges.push({
        start: match.index!,
        end: match.index! + match[0].length,
        name: match[1],
      });
    }
  }
  return ranges;
};
