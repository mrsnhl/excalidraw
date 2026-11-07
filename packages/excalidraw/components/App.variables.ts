import {
  CaptureUpdateAction,
  refreshVariableDependents,
} from "@excalidraw/element";

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
