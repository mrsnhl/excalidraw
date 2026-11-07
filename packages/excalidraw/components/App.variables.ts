import {
  CaptureUpdateAction,
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
  /** `<scene nonce>:<edited element ids>` the last pass has run for */
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
    const { scene, state } = this.app;
    const editingIds = [
      state.editingTextElement?.id,
      state.activeTableCell?.editing ? state.activeTableCell.elementId : null,
    ].filter((id): id is string => !!id);
    const getPassKey = () => `${scene.getSceneNonce()}:${editingIds.join(",")}`;

    if (getPassKey() === this.lastPassKey) {
      return;
    }
    // the updates scheduled for this commit aren't in the store's snapshot
    // yet, so it can't tell which changes the history has captured. Runs on
    // the next update instead, once they are.
    if (this.app.store.hasScheduledMicroActions) {
      this.app.setState({});
      return;
    }
    this.lastPassKey = getPassKey();

    const elements = scene.getElementsIncludingDeleted();
    const nextElements = refreshVariableDependents(elements, {
      variables: scene.getVariables(),
      skipIds: new Set(editingIds),
      renderEnvironment: this.app.renderEnvironment,
    });

    if (nextElements === elements) {
      return;
    }

    // a layout that never settles (e.g. something else re-breaking what this
    // fixes on each update) must not re-render forever. Only counts the fixes
    // of one synchronous update cascade, so it never stays switched off.
    if (++this.consecutiveFixes > 3) {
      return;
    }
    if (this.consecutiveFixes === 1) {
      Promise.resolve().then(() => {
        this.consecutiveFixes = 0;
      });
    }

    // not an undo step of its own: after an undo the text is re-derived. But
    // when a fixed element has changes the history hasn't captured yet, the
    // fix has to go along with them, or it'd swallow them
    const snapshotElements = this.app.store.snapshot.elements;
    const hasPendingChanges = nextElements.some(
      (element, index) =>
        element !== elements[index] &&
        snapshotElements.get(element.id)?.version !== elements[index].version,
    );
    this.app.updateScene({
      elements: nextElements,
      captureUpdate: hasPendingChanges
        ? CaptureUpdateAction.EVENTUALLY
        : CaptureUpdateAction.NEVER,
    });
    this.lastPassKey = getPassKey();
  }
}
