import {
  CaptureUpdateAction,
  buildVariableMap,
  getWinningVariableElements,
  isValidVariableName,
  newElementWith,
  newVariableElement,
  refreshVariableDependents,
} from "@excalidraw/element";

import type { CaptureUpdateActionType } from "@excalidraw/element";
import type {
  ExcalidrawElement,
  ExcalidrawVariableElement,
} from "@excalidraw/element/types";

import type { ClipboardVariable } from "../clipboard";

import type App from "./App";

/**
 * A pass that fixes up the text that depends on the scene variables on any
 * scene change: a variable edited, an undo/redo, a remote update, a load, a
 * paste, a host `updateScene`. The variable actions compute their dependents
 * on their own, so this one is the safety net for all the other paths.
 */
export class AppVariables {
  /** `<scene nonce>:<edited text id>` the last pass has run for */
  private lastPassKey: string | null = null;
  private consecutiveFixes = 0;

  constructor(private app: App) {}

  /**
   * The variables a paste brings along, minus the names the scene has already:
   * what the scene has for a name wins over what the source had.
   */
  public createMissing(
    pasted: readonly ClipboardVariable[] | undefined,
  ): ExcalidrawVariableElement[] {
    if (!pasted?.length) {
      return [];
    }
    const existing = this.app.scene.getVariables().map;
    const created = new Map<string, ExcalidrawVariableElement>();
    for (const { name, value } of pasted) {
      if (
        isValidVariableName(name) &&
        typeof value === "string" &&
        !existing.has(name) &&
        !created.has(name)
      ) {
        created.set(name, newVariableElement({ name, value }));
      }
    }
    return [...created.values()];
  }

  /** the name -> value map the texts resolve against */
  public get = (): Record<string, string> =>
    Object.fromEntries(this.app.scene.getVariables().map);

  /**
   * Upserts the variables by name, `null` deletes. Goes through a single
   * update, so that the change and the texts it re-derives are one history
   * entry (with the default `captureUpdate`).
   */
  public set = (
    variables: Record<string, string | null>,
    opts?: { captureUpdate?: CaptureUpdateActionType },
  ) => {
    const elements = this.app.scene.getElementsIncludingDeleted();
    const winners = new Map(
      getWinningVariableElements(elements).map((el) => [el.name, el]),
    );
    const replaced = new Map<string, ExcalidrawElement>();
    const added: ExcalidrawVariableElement[] = [];

    for (const [name, value] of Object.entries(variables)) {
      if (!isValidVariableName(name)) {
        console.warn(`setVariables: invalid variable name "${name}"`);
        continue;
      }
      const existing = winners.get(name);
      if (value === null) {
        if (existing) {
          replaced.set(
            existing.id,
            newElementWith(existing, { isDeleted: true }),
          );
        }
      } else if (existing) {
        if (existing.value !== value) {
          replaced.set(existing.id, newElementWith(existing, { value }));
        }
      } else {
        added.push(newVariableElement({ name, value }));
      }
    }

    if (!replaced.size && !added.length) {
      return;
    }

    const nextElements = [
      ...elements.map((element) => replaced.get(element.id) ?? element),
      ...added,
    ];
    this.app.updateScene({
      elements: refreshVariableDependents(nextElements, {
        variables: buildVariableMap(nextElements),
        renderEnvironment: this.app.renderEnvironment,
      }),
      captureUpdate: opts?.captureUpdate ?? CaptureUpdateAction.IMMEDIATELY,
    });
  };

  /**
   * To be called on each update, before the elements are read and the store
   * is committed. Cheap when the scene has not changed.
   */
  public refreshIfNeeded() {
    const { scene } = this.app;
    const editingId = this.app.state.editingTextElement?.id ?? null;
    const passKey = `${scene.getSceneNonce()}:${editingId}`;

    if (passKey === this.lastPassKey) {
      return;
    }
    this.lastPassKey = passKey;

    const elements = scene.getElementsIncludingDeleted();
    const nextElements = refreshVariableDependents(elements, {
      variables: scene.getVariables(),
      skipIds: editingId ? new Set([editingId]) : undefined,
      renderEnvironment: this.app.renderEnvironment,
    });

    if (nextElements === elements) {
      this.consecutiveFixes = 0;
      return;
    }

    // a layout that never settles would otherwise keep re-rendering forever
    if (++this.consecutiveFixes > 3) {
      return;
    }

    // never part of the history: after an undo the text is re-derived, it's
    // not an undo step of its own
    this.app.updateScene({
      elements: nextElements,
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    this.lastPassKey = `${scene.getSceneNonce()}:${editingId}`;
  }
}
