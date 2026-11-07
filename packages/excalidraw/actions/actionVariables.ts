import {
  DEFAULT_SIDEBAR,
  VARIABLES_SIDEBAR_TAB,
  VARIABLE_NAME_MAX_LENGTH,
  isValidVariableName,
  normalizeVariableName,
} from "@excalidraw/common";

import {
  CaptureUpdateAction,
  buildVariableMap,
  inlineVariableReferences,
  isVariableElement,
  newElementWith,
  newVariableElement,
  refreshVariableDependents,
  renameVariableReferences,
  rewriteVariableTexts,
} from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { variablesIcon } from "../components/icons";

import { register } from "./register";

import type { AppClassProperties } from "../types";
import type { ActionResult } from "./types";

/**
 * Re-derives the text that depends on the variables, so that the change and
 * its consequences land in the same history entry.
 */
const withRefreshedDependents = (
  elements: readonly ExcalidrawElement[],
  app: AppClassProperties,
): ActionResult => ({
  elements: refreshVariableDependents(elements, {
    renderEnvironment: app.renderEnvironment,
  }),
  captureUpdate: CaptureUpdateAction.IMMEDIATELY,
});

const getLiveVariable = (
  elements: readonly ExcalidrawElement[],
  id: string | undefined,
) => {
  const element = elements.find((element) => element.id === id);
  return element && isVariableElement(element) && !element.isDeleted
    ? element
    : null;
};

const isNameTaken = (
  elements: readonly ExcalidrawElement[],
  name: string,
  exceptId?: string,
) =>
  elements.some(
    (element) =>
      isVariableElement(element) &&
      !element.isDeleted &&
      element.id !== exceptId &&
      element.name === name,
  );

/** `name`, or `name_2`, `name_3`… whichever is the first one free */
export const getAvailableVariableName = (
  elements: readonly ExcalidrawElement[],
  name: string,
) => {
  if (!isNameTaken(elements, name)) {
    return name;
  }
  let suffix = 2;
  while (isNameTaken(elements, `${name}_${suffix}`)) {
    suffix++;
  }
  return `${name}_${suffix}`;
};

export const actionCreateVariable = register<{
  name?: string;
  value?: string;
}>({
  name: "createVariable",
  label: "variables.add",
  trackEvent: { category: "element", action: "createVariable" },
  perform: (elements, appState, formData, app) => {
    const baseName = normalizeVariableName(formData?.name ?? "variable");
    if (!isValidVariableName(baseName)) {
      return false;
    }
    // leave room for the suffix
    const name = getAvailableVariableName(
      elements,
      baseName.slice(0, VARIABLE_NAME_MAX_LENGTH - 8),
    );
    const variable = newVariableElement({ name, value: formData?.value ?? "" });
    return withRefreshedDependents([...elements, variable], app);
  },
});

export const actionUpdateVariable = register<{ id: string; value: string }>({
  name: "updateVariable",
  label: "variables.title",
  trackEvent: { category: "element", action: "updateVariable" },
  perform: (elements, appState, formData, app) => {
    const variable = getLiveVariable(elements, formData?.id);
    if (!variable || formData!.value === variable.value) {
      return false;
    }
    return withRefreshedDependents(
      elements.map((element) =>
        element === variable
          ? newElementWith(variable, { value: formData!.value })
          : element,
      ),
      app,
    );
  },
});

export const actionRenameVariable = register<{ id: string; name: string }>({
  name: "renameVariable",
  label: "variables.rename",
  trackEvent: { category: "element", action: "renameVariable" },
  perform: (elements, appState, formData, app) => {
    const variable = getLiveVariable(elements, formData?.id);
    const name = normalizeVariableName(formData?.name ?? "");
    if (
      !variable ||
      name === variable.name ||
      !isValidVariableName(name) ||
      isNameTaken(elements, name, variable.id)
    ) {
      return false;
    }
    // the references follow the variable, the displayed text stays the same
    const renamed = elements.map((element) =>
      element === variable ? newElementWith(variable, { name }) : element,
    );
    return withRefreshedDependents(
      rewriteVariableTexts(renamed, (text) =>
        renameVariableReferences(text, variable.name, name),
      ),
      app,
    );
  },
});

export type DeleteVariableMode =
  /** the `{{name}}` placeholders stay in the texts, as unknown ones */
  | "keep"
  /** the `{{name}}` placeholders are replaced with the value */
  | "inline";

export const actionDeleteVariable = register<{
  id: string;
  mode?: DeleteVariableMode;
}>({
  name: "deleteVariable",
  label: "variables.delete",
  trackEvent: { category: "element", action: "deleteVariable" },
  perform: (elements, appState, formData, app) => {
    const variable = getLiveVariable(elements, formData?.id);
    if (!variable) {
      return false;
    }
    let nextElements: readonly ExcalidrawElement[] = elements.map((element) =>
      element === variable
        ? newElementWith(variable, { isDeleted: true })
        : element,
    );
    if (formData!.mode === "inline") {
      // (the value of the one that is in effect, when the name is duplicated)
      const value = buildVariableMap(elements).map.get(variable.name);
      nextElements = rewriteVariableTexts(nextElements, (text) =>
        inlineVariableReferences(text, variable.name, value ?? variable.value),
      );
    }
    return withRefreshedDependents(nextElements, app);
  },
});

export const actionToggleVariablesMenu = register({
  name: "variablesMenu",
  icon: variablesIcon,
  keywords: ["variables", "placeholders", "tokens"],
  label: "variables.title",
  viewMode: true,
  trackEvent: { category: "menu", action: "toggleVariables" },
  perform(elements, appState) {
    if (appState.openDialog) {
      return false;
    }
    const isOpen =
      appState.openSidebar?.name === DEFAULT_SIDEBAR.name &&
      appState.openSidebar.tab === VARIABLES_SIDEBAR_TAB;

    return {
      appState: {
        ...appState,
        openSidebar: isOpen
          ? null
          : { name: DEFAULT_SIDEBAR.name, tab: VARIABLES_SIDEBAR_TAB },
        openDialog: null,
      },
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    };
  },
  checked: (appState) =>
    appState.openSidebar?.name === DEFAULT_SIDEBAR.name &&
    appState.openSidebar.tab === VARIABLES_SIDEBAR_TAB,
});
