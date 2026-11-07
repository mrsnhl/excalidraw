import { parseVariableReferences, resolveVariables } from "@excalidraw/common";

import type { VariableMap } from "@excalidraw/common";

import { newElementWith } from "./mutateElement";

import { isTableElement, isTextElement, isVariableElement } from "./typeChecks";

import { hashString } from ".";

import type {
  ExcalidrawElement,
  ExcalidrawTableElement,
  ExcalidrawTextElement,
  ExcalidrawVariableElement,
} from "./types";

export {
  VARIABLE_NAME_MAX_LENGTH,
  findUnknownVariableRanges,
  hasVariablePlaceholders,
  inlineVariableReferences,
  isValidVariableName,
  normalizeVariableName,
  parseVariableReferences,
  renameVariableReferences,
  resolveVariables,
} from "@excalidraw/common";

export type { VariableMap } from "@excalidraw/common";

export type SceneVariables = {
  map: VariableMap;
  /**
   * Changes whenever any variable is added, edited, renamed or deleted. Use as
   * a cache-invalidation key for anything derived from the map.
   */
  version: string;
};

/**
 * Hash of the variable elements' identity & version, deleted ones included
 * (deleting bumps the version, but we want to be defensive).
 */
export const getVariablesVersion = (
  variableElements: readonly ExcalidrawVariableElement[],
): string => {
  let hash = 5381;
  for (const element of variableElements) {
    hash =
      ((hash << 5) +
        hash +
        hashString(
          `${element.id}:${element.version}:${element.versionNonce}:${
            element.isDeleted ? 1 : 0
          }`,
        )) >>>
      0;
  }
  return `${variableElements.length}:${hash}`;
};

/**
 * Duplicate names are possible after concurrent creates (collab). The element
 * with the lowest fractional index wins, with `id` as the tiebreak.
 */
export const compareVariableElements = (
  a: ExcalidrawVariableElement,
  b: ExcalidrawVariableElement,
) => {
  const indexA = a.index ?? "";
  const indexB = b.index ?? "";
  if (indexA !== indexB) {
    return indexA < indexB ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** picks the non-deleted variable elements, in winner-first order */
export const getWinningVariableElements = (
  elements: readonly ExcalidrawElement[],
): ExcalidrawVariableElement[] => {
  const winners = new Map<string, ExcalidrawVariableElement>();
  for (const element of elements) {
    if (!isVariableElement(element) || element.isDeleted) {
      continue;
    }
    const current = winners.get(element.name);
    if (!current || compareVariableElements(element, current) < 0) {
      winners.set(element.name, element);
    }
  }
  return Array.from(winners.values());
};

/**
 * Builds the name -> value map out of any elements (non-variable ones are
 * ignored), following the duplicate rule of `compareVariableElements`.
 */
export const buildVariableMap = (
  elements: readonly ExcalidrawElement[],
): SceneVariables => {
  const variableElements = elements.filter(isVariableElement);
  const map = new Map<string, string>();
  for (const element of getWinningVariableElements(variableElements)) {
    map.set(element.name, element.value);
  }
  return { map, version: getVariablesVersion(variableElements) };
};

/** the text that is displayed for the given raw (placeholder) text */
export const getResolvedOriginalText = (
  textElement: { originalText: string },
  variables: VariableMap | null | undefined,
): string => resolveVariables(textElement.originalText, variables);

/**
 * How many elements reference each variable name (a name used several times
 * in one element counts once). Includes the names with no variable behind
 * them.
 */
export const countVariableUsage = (
  elements: readonly ExcalidrawElement[],
): Map<string, number> => {
  const usage = new Map<string, number>();
  const count = (text: string) => {
    for (const name of parseVariableReferences(text)) {
      usage.set(name, (usage.get(name) ?? 0) + 1);
    }
  };
  for (const element of elements) {
    if (element.isDeleted) {
      continue;
    }
    if (isTextElement(element)) {
      count(element.originalText);
    } else if (isTableElement(element)) {
      // all the cells of a table count as one element
      count(element.cells.map((row) => row.join("\n")).join("\n"));
    }
  }
  return usage;
};

/**
 * Applies `rewrite` to the raw (placeholder) text of every element that has
 * one. Returns the same array when nothing changed, otherwise a copy where
 * only the changed elements are new objects.
 */
export const rewriteVariableTexts = <T extends ExcalidrawElement>(
  elements: readonly T[],
  rewrite: (text: string) => string,
): readonly T[] => {
  let changed = false;
  const next = elements.map((element) => {
    if (element.isDeleted) {
      return element;
    }
    if (isTextElement(element)) {
      const originalText = rewrite(element.originalText);
      if (originalText !== element.originalText) {
        changed = true;
        return newElementWith<ExcalidrawTextElement>(element, {
          originalText,
        }) as ExcalidrawElement as T;
      }
    }
    if (isTableElement(element)) {
      let cellsChanged = false;
      const cells = element.cells.map((row) =>
        row.map((cell) => {
          const next = rewrite(cell);
          cellsChanged ||= next !== cell;
          return next;
        }),
      );
      if (cellsChanged) {
        changed = true;
        return newElementWith<ExcalidrawTableElement>(element, {
          cells,
        }) as ExcalidrawElement as T;
      }
    }
    return element;
  });
  return changed ? next : elements;
};
