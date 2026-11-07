import {
  CaptureUpdateAction,
  canDeleteTableColumn,
  canDeleteTableRow,
  deleteTableColumn,
  deleteTableRow,
  getTableColumnCount,
  getTableRowCount,
  getTableUpdate,
  insertTableColumn,
  insertTableRow,
  isTableElement,
  newElementWith,
} from "@excalidraw/element";

import type {
  ExcalidrawElement,
  ExcalidrawTableElement,
} from "@excalidraw/element/types";

import { CheckboxItem } from "../components/CheckboxItem";
import { t } from "../i18n";

import { changeProperty, getFormValue } from "./actionProperties";
import { register } from "./register";

import type { ActionResult } from "./types";
import type { ActiveTableCell, AppClassProperties, AppState } from "../types";

/**
 * `index` is where the row/column goes (insert) or which one is removed
 * (delete). Without it the actions work on the active cell, which is what the
 * context menu and the properties panel do.
 */
export type TableGridActionData = { elementId?: string; index?: number };

const getTargetTable = (
  appState: Readonly<AppState>,
  app: AppClassProperties,
  data?: TableGridActionData,
): ExcalidrawTableElement | null => {
  const elementId = data?.elementId ?? appState.activeTableCell?.elementId;
  const element = elementId ? app.scene.getElement(elementId) : null;
  return element && isTableElement(element) && !element.isDeleted
    ? element
    : null;
};

type GridEdit = "row" | "column";

const getGridActionResult = (
  appState: Readonly<AppState>,
  app: AppClassProperties,
  table: ExcalidrawTableElement,
  edit: GridEdit,
  getPatch: (table: ExcalidrawTableElement) => Partial<ExcalidrawTableElement>,
  getActiveCell: (
    next: ExcalidrawTableElement,
    prev: ActiveTableCell | null,
  ) => ActiveTableCell,
): ActionResult => {
  const next = newElementWith(
    table,
    getTableUpdate(
      table,
      getPatch(table),
      app.scene.getVariables().map,
      app.renderEnvironment,
    ),
  );
  const prev =
    appState.activeTableCell?.elementId === table.id
      ? appState.activeTableCell
      : null;

  return {
    elements: app.scene
      .getElementsIncludingDeleted()
      .map((element) => (element.id === table.id ? next : element)),
    appState: {
      ...appState,
      activeTableCell: { ...getActiveCell(next, prev), editing: false },
    },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  };
};

const hasRowSpan = (cell: ActiveTableCell | null) =>
  !!cell && cell.span !== "col";

const hasColumnSpan = (cell: ActiveTableCell | null) =>
  !!cell && cell.span !== "row";

/** the row a context-menu / panel invocation refers to */
const getRowIndex = (
  appState: Readonly<AppState>,
  data: TableGridActionData | undefined,
) => data?.index ?? appState.activeTableCell?.row;

const getColumnIndex = (
  appState: Readonly<AppState>,
  data: TableGridActionData | undefined,
) => data?.index ?? appState.activeTableCell?.col;

const canEditGrid = (
  appState: Readonly<AppState>,
  app: AppClassProperties,
  edit: GridEdit,
) =>
  !appState.viewModeEnabled &&
  !!getTargetTable(appState, app) &&
  (edit === "row"
    ? hasRowSpan(appState.activeTableCell)
    : hasColumnSpan(appState.activeTableCell));

const createInsertAction = (
  edit: GridEdit,
  name:
    | "tableInsertRowAbove"
    | "tableInsertRowBelow"
    | "tableInsertColumnLeft"
    | "tableInsertColumnRight",
  label: string,
  offset: 0 | 1,
) =>
  register<TableGridActionData | undefined>({
    name,
    label,
    trackEvent: { category: "element" },
    predicate: (elements, appState, _, app) => canEditGrid(appState, app, edit),
    perform: (elements, appState, data, app) => {
      const table = getTargetTable(appState, app, data);
      const base =
        edit === "row"
          ? getRowIndex(appState, data)
          : getColumnIndex(appState, data);
      if (!table || base === undefined) {
        return false;
      }
      // an explicit index is already the insertion position
      const at = data?.index !== undefined ? base : base + offset;

      return getGridActionResult(
        appState,
        app,
        table,
        edit,
        (table) =>
          edit === "row"
            ? insertTableRow(table, at)
            : insertTableColumn(table, at),
        (next, prev) => {
          const size =
            edit === "row" ? getTableRowCount(next) : getTableColumnCount(next);
          const index = Math.min(at, size - 1);
          return {
            elementId: next.id,
            row: edit === "row" ? index : prev?.row ?? 0,
            col: edit === "column" ? index : prev?.col ?? 0,
            // a single cell stays a cell, anything else selects the new line
            span:
              prev?.span === "cell" ? "cell" : edit === "row" ? "row" : "col",
            editing: false,
          };
        },
      );
    },
  });

const createDeleteAction = (
  edit: GridEdit,
  name: "tableDeleteRow" | "tableDeleteColumn",
  label: string,
) =>
  register<TableGridActionData | undefined>({
    name,
    label,
    trackEvent: { category: "element" },
    predicate: (elements, appState, _, app) => {
      const table = getTargetTable(appState, app);
      return (
        canEditGrid(appState, app, edit) &&
        !!table &&
        (edit === "row"
          ? canDeleteTableRow(table)
          : canDeleteTableColumn(table))
      );
    },
    perform: (elements, appState, data, app) => {
      const table = getTargetTable(appState, app, data);
      const at =
        edit === "row"
          ? getRowIndex(appState, data)
          : getColumnIndex(appState, data);
      if (
        !table ||
        at === undefined ||
        !(edit === "row"
          ? canDeleteTableRow(table)
          : canDeleteTableColumn(table))
      ) {
        return false;
      }

      return getGridActionResult(
        appState,
        app,
        table,
        edit,
        (table) =>
          edit === "row"
            ? deleteTableRow(table, at)
            : deleteTableColumn(table, at),
        (next, prev) => {
          const size =
            edit === "row" ? getTableRowCount(next) : getTableColumnCount(next);
          const index = Math.min(at, size - 1);
          return {
            elementId: next.id,
            row: edit === "row" ? index : prev?.row ?? 0,
            col: edit === "column" ? index : prev?.col ?? 0,
            span: prev?.span ?? "cell",
            editing: false,
          };
        },
      );
    },
  });

export const actionTableInsertRowAbove = createInsertAction(
  "row",
  "tableInsertRowAbove",
  "labels.tableInsertRowAbove",
  0,
);

export const actionTableInsertRowBelow = createInsertAction(
  "row",
  "tableInsertRowBelow",
  "labels.tableInsertRowBelow",
  1,
);

export const actionTableInsertColumnLeft = createInsertAction(
  "column",
  "tableInsertColumnLeft",
  "labels.tableInsertColumnLeft",
  0,
);

export const actionTableInsertColumnRight = createInsertAction(
  "column",
  "tableInsertColumnRight",
  "labels.tableInsertColumnRight",
  1,
);

export const actionTableDeleteRow = createDeleteAction(
  "row",
  "tableDeleteRow",
  "labels.tableDeleteRow",
);

export const actionTableDeleteColumn = createDeleteAction(
  "column",
  "tableDeleteColumn",
  "labels.tableDeleteColumn",
);

export const actionToggleTableHeaderRow = register<boolean | undefined>({
  name: "toggleTableHeaderRow",
  label: "labels.tableHeaderRow",
  trackEvent: { category: "element" },
  predicate: (elements, appState, _, app) =>
    !appState.viewModeEnabled &&
    app.scene.getSelectedElements(appState).some(isTableElement),
  perform: (elements, appState, value, app) => {
    const tables = app.scene
      .getSelectedElements(appState)
      .filter(isTableElement);
    if (!tables.length) {
      return false;
    }
    // without an explicit value flip the common state (mixed -> on)
    const next = value ?? !tables.every((table) => table.headerRow);

    return {
      elements: changeProperty(elements, appState, (element) =>
        isTableElement(element) && element.headerRow !== next
          ? newElementWith(
              element,
              getTableUpdate(
                element,
                { headerRow: next },
                app.scene.getVariables().map,
                app.renderEnvironment,
              ),
            )
          : element,
      ),
      appState,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
  PanelComponent: ({ elements, app, updateData }) => {
    const headerRow = getFormValue(
      elements,
      app,
      (element: ExcalidrawElement) =>
        isTableElement(element) ? element.headerRow : null,
      isTableElement,
      false,
    );

    return (
      <CheckboxItem
        checked={!!headerRow}
        onChange={(checked) => updateData(checked)}
      >
        {t("labels.tableHeaderRow")}
      </CheckboxItem>
    );
  },
});
