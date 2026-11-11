import {
  CaptureUpdateAction,
  isHtmlElement,
  newElementWith,
} from "@excalidraw/element";

import type { ExcalidrawHtmlElement } from "@excalidraw/element/types";

import { IconButton } from "../components/IconButton";
import { htmlToolIcon } from "../components/icons";
import { t } from "../i18n";

import { register } from "./register";

import type { AppClassProperties, AppState } from "../types";

/** the HTML frame the editor opens for: the single selected, unlocked one */
const getEditableHtmlFrame = (
  appState: Readonly<AppState>,
  app: AppClassProperties,
): ExcalidrawHtmlElement | null => {
  if (appState.viewModeEnabled) {
    return null;
  }
  const selected = app.scene.getSelectedElements(appState);
  const [element] = selected;
  return selected.length === 1 && isHtmlElement(element) && !element.locked
    ? element
    : null;
};

export const actionEditHtmlFrame = register({
  name: "editHtmlFrame",
  label: "labels.editHtml",
  icon: htmlToolIcon,
  trackEvent: { category: "element" },
  keywords: ["html", "code", "iframe"],
  predicate: (elements, appState, _, app) =>
    !!getEditableHtmlFrame(appState, app),
  perform: (elements, appState, _, app) => {
    const element = getEditableHtmlFrame(appState, app);
    if (!element) {
      return false;
    }
    return {
      appState: {
        ...appState,
        openDialog: { name: "htmlEditor", elementId: element.id },
      },
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    };
  },
  PanelComponent: ({ updateData }) => {
    const label = t("labels.editHtml");
    return (
      <IconButton
        type="button"
        icon={htmlToolIcon}
        title={label}
        aria-label={label}
        data-testid="edit-html-button"
        onClick={() => updateData(null)}
      />
    );
  },
});

export type UpdateHtmlFrameData = {
  elementId: ExcalidrawHtmlElement["id"];
  html: string;
};

export const actionUpdateHtmlFrame = register<UpdateHtmlFrameData>({
  name: "updateHtmlFrame",
  label: "labels.editHtml",
  trackEvent: { category: "element" },
  perform: (elements, appState, data) => {
    if (!data) {
      return false;
    }
    let changed = false;
    const nextElements = elements.map((element) => {
      if (
        element.id !== data.elementId ||
        !isHtmlElement(element) ||
        element.locked ||
        element.html === data.html
      ) {
        return element;
      }
      changed = true;
      return newElementWith(element, { html: data.html });
    });
    if (!changed) {
      return false;
    }
    return {
      elements: nextElements,
      appState,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
});
