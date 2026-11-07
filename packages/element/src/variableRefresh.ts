import { arrayToMap, resolveVariables } from "@excalidraw/common";

import { updateBoundElements } from "./binding";
import { refreshTextDimensions } from "./newElement";
import { Scene } from "./Scene";
import { updateStickyNoteLayout } from "./stickyNote";
import { getContainerElement, redrawTextBoundingBox } from "./textElement";
import {
  isStickyNoteElement,
  isTextElement,
  isVariableElement,
} from "./typeChecks";
import { buildVariableMap } from "./variables";

import type { RenderEnvironment } from "./renderEnvironment";
import type { SceneVariables } from "./variables";
import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
  NonDeletedExcalidrawElement,
} from "./types";

const stripWhitespace = (text: string) => text.replace(/\s+/g, "");

/**
 * Elements verified to be fresh for the given variables version, so repeated
 * passes over an unchanged scene are cheap. The element version is a part of
 * the key as elements can be mutated in place.
 */
const verifiedFresh = new WeakMap<ExcalidrawElement, string>();

const getFreshnessKey = (
  element: ExcalidrawElement,
  variablesVersion: string,
) => `${variablesVersion}|${element.version}`;

/**
 * The displayed text is stale when it differs from the resolved `originalText`.
 * Whitespace is ignored on purpose: wrapping depends on the font metrics of
 * the client, and clients with different metrics must not keep rewriting each
 * other's text.
 */
const isTextStale = (
  element: ExcalidrawTextElement,
  variables: SceneVariables,
) =>
  stripWhitespace(element.text) !==
  stripWhitespace(resolveVariables(element.originalText, variables.map));

/**
 * Re-lays out the given stale texts inside the (scratch) scene. Mutates it.
 */
const refreshStaleTexts = (
  scene: Scene,
  staleTextIds: readonly string[],
  renderEnvironment: RenderEnvironment | undefined,
) => {
  const handledStickyNotes = new Set<string>();

  for (const id of staleTextIds) {
    const textElement = scene.getElement(id);
    if (!textElement || !isTextElement(textElement) || textElement.isDeleted) {
      continue;
    }
    const elementsMap = scene.getNonDeletedElementsMap();
    const container = getContainerElement(textElement, elementsMap);

    if (container && isStickyNoteElement(container)) {
      if (!handledStickyNotes.has(container.id)) {
        handledStickyNotes.add(container.id);
        // (runs the bound-arrow pass as well)
        updateStickyNoteLayout(container, scene, { renderEnvironment });
      }
    } else if (container) {
      // re-wraps the label, and grows the container (but never shrinks it)
      redrawTextBoundingBox(textElement, container, scene, renderEnvironment);
      updateBoundElements(container as NonDeletedExcalidrawElement, scene, {
        renderEnvironment,
      });
    } else {
      scene.mutateElement(
        textElement,
        refreshTextDimensions(
          textElement,
          null,
          elementsMap,
          resolveVariables(textElement.originalText, scene.getVariables().map),
          undefined,
          renderEnvironment,
        ) ?? {},
      );
      updateBoundElements(textElement as NonDeletedExcalidrawElement, scene, {
        renderEnvironment,
      });
    }
  }
};

// tables: wired after merge
// Re-lays out the tables (`refreshTableLayout(table, variables.map)`) whose
// cells reference variables, inside the (scratch) scene. Mutates it.
const refreshStaleTables = (
  _scene: Scene,
  _variables: SceneVariables,
  _skipIds: ReadonlySet<string>,
  _renderEnvironment: RenderEnvironment | undefined,
) => {};

/**
 * Re-derives the displayed text of the elements that reference variables and
 * whose cached `text` (and the dimensions that depend on it) is out of date:
 * after a variable changed, an undo/redo, a remote update, a load, a paste…
 *
 * It's pure: the given elements and the scene they come from are untouched.
 * Returns the same array when there's nothing to do, otherwise a copy where
 * the refreshed elements (and the ones they pushed around: containers, bound
 * arrows) are new objects.
 */
export const refreshVariableDependents = <T extends ExcalidrawElement>(
  elements: readonly T[],
  opts: {
    /** pass if already known (e.g. `scene.getVariables()`) */
    variables?: SceneVariables;
    /** elements being edited, whose raw text must stay as it is */
    skipIds?: ReadonlySet<string>;
    renderEnvironment?: RenderEnvironment;
  } = {},
): readonly T[] => {
  const variables = opts.variables ?? buildVariableMap(elements);
  const skipIds = opts.skipIds ?? new Set<string>();

  const staleTextIds: string[] = [];
  const hasStaleTables = false;

  for (const element of elements) {
    if (
      element.isDeleted ||
      isVariableElement(element) ||
      skipIds.has(element.id)
    ) {
      continue;
    }
    if (
      verifiedFresh.get(element) === getFreshnessKey(element, variables.version)
    ) {
      continue;
    }
    if (isTextElement(element)) {
      if (!element.originalText.includes("{{")) {
        continue;
      }
      if (isTextStale(element, variables)) {
        staleTextIds.push(element.id);
      } else {
        verifiedFresh.set(element, getFreshnessKey(element, variables.version));
      }
    }
    // tables: wired after merge (change `hasStaleTables` to `let`, and set it for the tables with
    // cells that reference variables and a layout that is out of date)
  }

  if (!staleTextIds.length && !hasStaleTables) {
    return elements;
  }

  // the layout helpers mutate elements (through the scene), so let them do it
  // on copies
  const scratch = new Scene();
  const copies = elements.map((element) => ({ ...element }));
  scratch.replaceAllElements(copies, { skipValidation: true });

  refreshStaleTexts(scratch, staleTextIds, opts.renderEnvironment);
  refreshStaleTables(scratch, variables, skipIds, opts.renderEnvironment);

  const originalsMap = arrayToMap(elements);
  const changed = new Map<string, ExcalidrawElement>();
  for (const copy of copies) {
    if (copy.version !== originalsMap.get(copy.id)!.version) {
      changed.set(copy.id, copy);
    }
  }

  if (!changed.size) {
    return elements;
  }

  return elements.map((element) => (changed.get(element.id) as T) ?? element);
};
