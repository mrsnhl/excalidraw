import { useEffect, useState } from "react";

import { sceneCoordsToViewportCoords } from "@excalidraw/common";

import { pointRotateRads } from "@excalidraw/math";

import type { GlobalPoint } from "@excalidraw/math";

import { t } from "../i18n";
import {
  getUnknownVariableHighlights,
  hitUnknownVariable,
} from "../renderer/unknownVariables";

import { useApp, useExcalidrawAppState, useExcalidrawContainer } from "./App";

import "./UnknownVariableTooltip.scss";

type Hover = { name: string; left: number; top: number };

/**
 * Says what the red-tinted `{{name}}` on the canvas (see
 * `renderUnknownVariables`) is about, when the pointer rests on it.
 */
export const UnknownVariableTooltip = () => {
  const app = useApp();
  const appState = useExcalidrawAppState();
  const { container } = useExcalidrawContainer();
  const [hover, setHover] = useState<Hover | null>(null);

  const { selectedElementIds, editingTextElement } = appState;
  const { zoom, scrollX, scrollY, offsetLeft, offsetTop } = appState;

  useEffect(() => {
    // whatever the pointer was on may be gone
    setHover(null);
  }, [selectedElementIds, editingTextElement, zoom, scrollX, scrollY]);

  useEffect(() => {
    if (!container) {
      return;
    }
    const onPointerMove = (event: PointerEvent) => {
      const state = app.state;
      const highlights = getUnknownVariableHighlights(
        app.scene.getSelectedElements(state),
        state.editingTextElement?.id ?? null,
        app.scene.getVariables().map,
        app.scene.getNonDeletedElementsMap(),
        app.renderEnvironment,
        state.activeTableCell?.editing ? state.activeTableCell : null,
      );
      if (!highlights.length) {
        setHover((hover) => (hover ? null : hover));
        return;
      }
      const hit = hitUnknownVariable(
        highlights,
        (event.clientX - state.offsetLeft) / state.zoom.value - state.scrollX,
        (event.clientY - state.offsetTop) / state.zoom.value - state.scrollY,
      );
      if (!hit) {
        setHover((hover) => (hover ? null : hover));
        return;
      }
      // below the (rotated) bottom-left corner of the name
      const { rect, highlight } = hit;
      const [sceneX, sceneY] = pointRotateRads(
        [rect.x, rect.y + rect.height] as GlobalPoint,
        [highlight.cx, highlight.cy] as GlobalPoint,
        highlight.angle,
      );
      const { x, y } = sceneCoordsToViewportCoords({ sceneX, sceneY }, state);
      setHover((hover) =>
        hover?.name === hit.name && hover.left === x && hover.top === y
          ? hover
          : { name: hit.name, left: x, top: y },
      );
    };
    const onPointerLeave = () => setHover(null);

    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerleave", onPointerLeave);
    return () => {
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerleave", onPointerLeave);
    };
  }, [app, container, offsetLeft, offsetTop]);

  if (!hover) {
    return null;
  }

  return (
    <div
      className="UnknownVariableTooltip"
      role="tooltip"
      style={{ left: hover.left, top: hover.top + 8 }}
    >
      {t("variables.unknownTooltip", { name: hover.name })}
    </div>
  );
};
