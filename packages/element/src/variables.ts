import { resolveVariables } from "@excalidraw/common";

import { hashString } from ".";
import { isVariableElement } from "./typeChecks";

import type { VariableMap } from "@excalidraw/common";

import type { ExcalidrawElement, ExcalidrawVariableElement } from "./types";

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
