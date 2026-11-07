import { getFontString } from "@excalidraw/common";

import {
  findUnknownVariableRanges,
  getBoundTextElement,
  getLineHeightInPx,
  getLineWidth,
  getTextElementWithAccuratePosition,
} from "@excalidraw/element";

import { pointRotateRads } from "@excalidraw/math";

import type { GlobalPoint, Radians } from "@excalidraw/math";

import type {
  ElementsMap,
  ExcalidrawElement,
  ExcalidrawTextElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";
import type { RenderEnvironment, VariableMap } from "@excalidraw/element";

export type UnknownVariableRect = {
  /** scene coords of the (unrotated) rect */
  x: number;
  y: number;
  width: number;
  height: number;
  name: string;
};

export type UnknownVariableHighlight = {
  /** center of the text element, which the rects are rotated about */
  cx: number;
  cy: number;
  angle: Radians;
  rects: UnknownVariableRect[];
};

/**
 * Where each unknown `{{name}}` of the text sits on the canvas. The cached
 * `text` is what's drawn (wrapped, and resolved but for the unknown names,
 * which stay as written), so that's what gets measured; a name that wrapping
 * would split in two is not highlighted.
 */
export const getUnknownVariableHighlight = (
  textElement: ExcalidrawTextElement,
  variables: VariableMap,
  elementsMap: ElementsMap,
  renderEnvironment: RenderEnvironment,
): UnknownVariableHighlight | null => {
  if (!textElement.text.includes("{{")) {
    return null;
  }
  const element = getTextElementWithAccuratePosition(textElement, elementsMap);
  const font = getFontString(element);
  const lineHeight = getLineHeightInPx(element.fontSize, element.lineHeight);
  const rects: UnknownVariableRect[] = [];

  element.text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .forEach((line, index) => {
      const ranges = findUnknownVariableRanges(line, variables);
      if (!ranges.length) {
        return;
      }
      const lineWidth = getLineWidth(line, font, renderEnvironment);
      const lineX =
        element.textAlign === "center"
          ? (element.width - lineWidth) / 2
          : element.textAlign === "right"
          ? element.width - lineWidth
          : 0;
      for (const { start, end, name } of ranges) {
        const offset = getLineWidth(
          line.slice(0, start),
          font,
          renderEnvironment,
        );
        rects.push({
          x: element.x + lineX + offset,
          y: element.y + index * lineHeight,
          width: getLineWidth(line.slice(start, end), font, renderEnvironment),
          height: lineHeight,
          name,
        });
      }
    });

  if (!rects.length) {
    return null;
  }
  return {
    cx: element.x + element.width / 2,
    cy: element.y + element.height / 2,
    angle: element.angle,
    rects,
  };
};

/**
 * The texts whose unknown variables get highlighted: the selected ones, the
 * label of a selected container, and the one being edited.
 */
export const getUnknownVariableHighlights = (
  selectedElements: readonly NonDeletedExcalidrawElement[],
  editingTextElementId: ExcalidrawElement["id"] | null,
  variables: VariableMap,
  elementsMap: ElementsMap,
  renderEnvironment: RenderEnvironment,
): UnknownVariableHighlight[] => {
  const texts = new Map<ExcalidrawElement["id"], ExcalidrawTextElement>();
  const add = (element: ExcalidrawElement | null | undefined) => {
    if (element && element.type === "text" && !element.isDeleted) {
      texts.set(element.id, element);
    }
  };
  for (const element of selectedElements) {
    add(element);
    add(getBoundTextElement(element, elementsMap));
  }
  if (editingTextElementId) {
    add(elementsMap.get(editingTextElementId));
  }

  const highlights: UnknownVariableHighlight[] = [];
  for (const text of texts.values()) {
    const highlight = getUnknownVariableHighlight(
      text,
      variables,
      elementsMap,
      renderEnvironment,
    );
    if (highlight) {
      highlights.push(highlight);
    }
  }
  return highlights;
};

/** The unknown variable under the scene point, if any. */
export const hitUnknownVariable = (
  highlights: readonly UnknownVariableHighlight[],
  sceneX: number,
  sceneY: number,
): {
  name: string;
  rect: UnknownVariableRect;
  highlight: UnknownVariableHighlight;
} | null => {
  for (const highlight of highlights) {
    // un-rotate the point instead of rotating every rect
    const [x, y] = pointRotateRads(
      [sceneX, sceneY] as GlobalPoint,
      [highlight.cx, highlight.cy] as GlobalPoint,
      -highlight.angle as Radians,
    );
    const rect = highlight.rects.find(
      (rect) =>
        x >= rect.x &&
        x <= rect.x + rect.width &&
        y >= rect.y &&
        y <= rect.y + rect.height,
    );
    if (rect) {
      return { name: rect.name, rect, highlight };
    }
  }
  return null;
};
