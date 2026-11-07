import { sceneCoordsToViewportCoords } from "@excalidraw/common";
import {
  TABLE_GRIP_GAP,
  TABLE_GRIP_THICKNESS,
  getTableColumnOffsets,
  getTableRowOffsets,
  getTableScenePoint,
  canDeleteTableColumn,
  canDeleteTableRow,
} from "@excalidraw/element";

import type { ExcalidrawTableElement } from "@excalidraw/element/types";

import {
  actionTableDeleteColumn,
  actionTableDeleteRow,
  actionTableInsertColumnLeft,
  actionTableInsertColumnRight,
  actionTableInsertRowAbove,
  actionTableInsertRowBelow,
} from "../actions";
import { t } from "../i18n";

import {
  tableColumnDeleteIcon,
  tableColumnInsertLeftIcon,
  tableColumnInsertRightIcon,
  tableRowDeleteIcon,
  tableRowInsertAboveIcon,
  tableRowInsertBelowIcon,
} from "./icons";
import {
  useApp,
  useExcalidrawActionManager,
  useExcalidrawAppState,
} from "./App";

import "./TableLineActions.scss";

/** distance between the grip and the bar, in screen pixels */
const BAR_GAP = 8;

/**
 * Floating bar for the selected table row / column: insert before, insert
 * after and delete. Sits next to the line's grip, like `ElementCanvasButtons`
 * sits next to its element.
 */
export const TableLineActions = ({
  element,
}: {
  element: ExcalidrawTableElement;
}) => {
  const app = useApp();
  const appState = useExcalidrawAppState();
  const actionManager = useExcalidrawActionManager();
  const active = appState.activeTableCell;

  if (
    !active ||
    active.elementId !== element.id ||
    active.editing ||
    active.span === "cell" ||
    appState.contextMenu ||
    appState.newElement ||
    appState.resizingElement ||
    appState.isRotating ||
    appState.openMenu ||
    appState.viewModeEnabled ||
    appState.selectedElementsAreBeingDragged
  ) {
    return null;
  }

  const isColumn = active.span === "col";
  const index = isColumn ? active.col : active.row;
  const gripOffset =
    (TABLE_GRIP_GAP + TABLE_GRIP_THICKNESS / 2) / appState.zoom.value;

  const localPoint: [number, number] = isColumn
    ? [
        getTableColumnOffsets(element)[index] + element.columnWidths[index] / 2,
        -gripOffset,
      ]
    : [
        -gripOffset,
        getTableRowOffsets(element)[index] + element.rowHeights[index] / 2,
      ];
  const [sceneX, sceneY] = getTableScenePoint(element, localPoint);
  const viewport = sceneCoordsToViewportCoords({ sceneX, sceneY }, appState);
  const x = viewport.x - appState.offsetLeft;
  const y = viewport.y - appState.offsetTop;

  const run = (
    action: typeof actionTableInsertColumnLeft | typeof actionTableDeleteColumn,
    at: number,
  ) => {
    actionManager.executeAction(action, "ui", {
      elementId: element.id,
      index: at,
    });
    // the keys that follow go to the active cell, not to this button
    app.focusContainer();
  };

  const canDelete = isColumn
    ? canDeleteTableColumn(element)
    : canDeleteTableRow(element);

  const buttons = isColumn
    ? [
        {
          action: actionTableInsertColumnLeft,
          label: t("labels.tableInsertColumnLeft"),
          icon: tableColumnInsertLeftIcon,
          at: index,
        },
        {
          action: actionTableInsertColumnRight,
          label: t("labels.tableInsertColumnRight"),
          icon: tableColumnInsertRightIcon,
          at: index + 1,
        },
      ]
    : [
        {
          action: actionTableInsertRowAbove,
          label: t("labels.tableInsertRowAbove"),
          icon: tableRowInsertAboveIcon,
          at: index,
        },
        {
          action: actionTableInsertRowBelow,
          label: t("labels.tableInsertRowBelow"),
          icon: tableRowInsertBelowIcon,
          at: index + 1,
        },
      ];
  const deleteAction = isColumn
    ? actionTableDeleteColumn
    : actionTableDeleteRow;
  const deleteLabel = isColumn
    ? t("labels.tableDeleteColumn")
    : t("labels.tableDeleteRow");

  return (
    <div
      className={`excalidraw-table-line-actions excalidraw-table-line-actions--${
        isColumn ? "column" : "row"
      }`}
      style={{
        left: `${x}px`,
        top: `${y}px`,
        ["--table-bar-gap" as string]: `${BAR_GAP}px`,
      }}
      role="toolbar"
      aria-label={
        isColumn ? t("labels.tableColumnActions") : t("labels.tableRowActions")
      }
      data-testid="table-line-actions"
    >
      {buttons.map(({ action, label, icon, at }) => (
        <button
          key={action.name}
          type="button"
          title={label}
          aria-label={label}
          data-testid={action.name}
          onClick={() => run(action, at)}
        >
          {icon}
        </button>
      ))}
      <div className="excalidraw-table-line-actions__separator" />
      <button
        type="button"
        className="danger"
        title={deleteLabel}
        aria-label={deleteLabel}
        data-testid={deleteAction.name}
        disabled={!canDelete}
        onClick={() => run(deleteAction, index)}
      >
        {isColumn ? tableColumnDeleteIcon : tableRowDeleteIcon}
      </button>
    </div>
  );
};
