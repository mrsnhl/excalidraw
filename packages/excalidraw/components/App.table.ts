import { flushSync } from "react-dom";

import {
  KEYS,
  POINTER_BUTTON,
  EVENT,
  sceneCoordsToViewportCoords,
  viewportCoordsToSceneCoords,
} from "@excalidraw/common";

import {
  getTableCellAtPoint,
  getTableColumnCount,
  getTableColumnOffsets,
  getTableControlAtPoint,
  getTableDividerAtPoint,
  getTableLocalPoint,
  getTableRowCount,
  getTableRowOffsets,
  getTableUpdate,
  insertTableRow,
  isSameTableControl,
  isTableElement,
  resizeTableColumn,
  resizeTableRow,
  setTableCell,
} from "@excalidraw/element";

import type { TableUpdate } from "@excalidraw/element";
import type {
  ExcalidrawTableElement,
  NonDeleted,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

import {
  actionTableInsertColumnLeft,
  actionTableInsertRowAbove,
} from "../actions/actionTable";
import { withBatchedUpdates } from "../reactUtils";
import { tableCellWysiwyg } from "../wysiwyg/tableCellWysiwyg";

import type { ActiveTableCell, PointerDownState } from "../types";
import type App from "./App";

type AppTableDependencies = {
  getContainer: () => HTMLDivElement | null;
};

type TableControlSpan = ActiveTableCell["span"];

type CellOptions = {
  /** replaces the cell's text instead of editing it (a typed character) */
  initialValue?: string;
};

const CURSOR_COL_RESIZE = "col-resize";
const CURSOR_ROW_RESIZE = "row-resize";

/**
 * Everything the app does for a table beyond what any element gets:
 *
 * - the active cell (or row/column) of the selected table, and the editing
 *   session of one cell (`startCellEditing`, see `tableCellWysiwyg`)
 * - the pointer interaction with the table's own controls: grips, insert
 *   handles and the dividers that resize columns and rows
 * - the keyboard navigation of a selected table
 */
export class AppTable {
  /** submits the open cell editor (if there is one) */
  public submitHandler: (() => void) | null = null;

  constructor(private app: App, private dependencies: AppTableDependencies) {}

  /** the lone selected table, which owns the active cell and the controls */
  public getSelectedTable(): NonDeleted<ExcalidrawTableElement> | null {
    const selected = this.app.scene.getSelectedElements(this.app.state);
    if (selected.length !== 1) {
      return null;
    }
    const element = selected[0];
    return isTableElement(element) && !element.locked ? element : null;
  }

  public getActiveCell(
    table: ExcalidrawTableElement | null = this.getSelectedTable(),
  ): ActiveTableCell | null {
    const cell = this.app.state.activeTableCell;
    return table && cell?.elementId === table.id ? cell : null;
  }

  // ---------------------------------------------------------------------------
  // the active cell
  // ---------------------------------------------------------------------------

  public setActiveCell(
    table: ExcalidrawTableElement,
    row: number,
    col: number,
    span: TableControlSpan = "cell",
  ) {
    const prev = this.app.state.activeTableCell;
    if (
      prev &&
      prev.elementId === table.id &&
      prev.row === row &&
      prev.col === col &&
      prev.span === span &&
      !prev.editing
    ) {
      return;
    }
    this.app.setState({
      activeTableCell: { elementId: table.id, row, col, span, editing: false },
    });
  }

  public clearActiveCell() {
    if (this.app.state.activeTableCell) {
      this.app.setState({ activeTableCell: null });
    }
  }

  /**
   * Moves the active cell by whole cells. A selected row (column) turns into
   * a single cell when moved along its length.
   */
  public moveActiveCell(
    table: ExcalidrawTableElement,
    dRow: number,
    dCol: number,
  ) {
    const cell = this.getActiveCell(table);
    if (!cell) {
      return;
    }
    const row = Math.min(
      Math.max(cell.row + dRow, 0),
      getTableRowCount(table) - 1,
    );
    const col = Math.min(
      Math.max(cell.col + dCol, 0),
      getTableColumnCount(table) - 1,
    );
    const span =
      (cell.span === "row" && dCol) || (cell.span === "col" && dRow)
        ? "cell"
        : cell.span;
    this.setActiveCell(table, row, col, span);
  }

  /** keeps the active cell valid for the selection and the grid */
  public sync() {
    const { activeTableCell: cell, hoveredTableControl } = this.app.state;
    const table = this.getSelectedTable();

    if (hoveredTableControl && !table) {
      this.app.setState({ hoveredTableControl: null });
    }
    if (!cell) {
      return;
    }

    const toolType = this.app.state.activeTool.type;
    const isValid =
      !!table &&
      table.id === cell.elementId &&
      (cell.editing || toolType === "selection" || toolType === "lasso");

    if (!isValid) {
      if (cell.editing) {
        // after the current update, the editor submits with a flushSync
        const submit = this.submitHandler;
        queueMicrotask(() => {
          if (submit && this.submitHandler === submit) {
            submit();
          }
        });
      }
      this.app.setState({ activeTableCell: null });
      return;
    }

    const row = Math.min(cell.row, getTableRowCount(table) - 1);
    const col = Math.min(cell.col, getTableColumnCount(table) - 1);
    if (row !== cell.row || col !== cell.col) {
      this.app.setState({ activeTableCell: { ...cell, row, col } });
    }
  }

  // ---------------------------------------------------------------------------
  // editing
  // ---------------------------------------------------------------------------

  /** applies a grid edit, refreshing the layout against the variables */
  private updateTable(table: ExcalidrawTableElement, patch: TableUpdate) {
    this.app.scene.mutateElement(
      table,
      getTableUpdate(
        table,
        patch,
        this.app.scene.getVariables().map,
        this.app.renderEnvironment,
      ),
    );
  }

  private setCellText(
    elementId: string,
    row: number,
    col: number,
    text: string,
  ) {
    const table = this.app.scene.getNonDeletedElement(elementId);
    if (
      !table ||
      !isTableElement(table) ||
      table.cells[row]?.[col] === undefined ||
      table.cells[row][col] === text
    ) {
      return;
    }
    this.updateTable(table, setTableCell(table, row, col, text));
  }

  public startCellEditing(
    element: ExcalidrawTableElement,
    row: number,
    col: number,
    { initialValue }: CellOptions = {},
  ) {
    const app = this.app;
    this.submitHandler?.();

    const table = app.scene.getNonDeletedElement(element.id);
    if (
      !table ||
      !isTableElement(table) ||
      table.cells[row]?.[col] === undefined
    ) {
      return;
    }
    const startText = table.cells[row][col];

    if (!this.getSelectedTable() || this.getSelectedTable()!.id !== table.id) {
      app.selection.select(table);
    }
    flushSync(() => {
      app.setState({
        activeTableCell: {
          elementId: table.id,
          row,
          col,
          span: "cell",
          editing: true,
        },
        hoveredTableControl: null,
      });
    });

    this.submitHandler = tableCellWysiwyg({
      canvas: app.canvas,
      excalidrawContainer: this.dependencies.getContainer(),
      app,
      element: table,
      row,
      col,
      initialValue: initialValue ?? null,
      autoSelect: !app.editorInterface.isTouchScreen,
      getViewportCoords: (x, y) => {
        const { x: viewportX, y: viewportY } = sceneCoordsToViewportCoords(
          { sceneX: x, sceneY: y },
          app.state,
        );
        return [
          viewportX - app.state.offsetLeft,
          viewportY - app.state.offsetTop,
        ];
      },
      onChange: withBatchedUpdates((text) => {
        this.setCellText(table.id, row, col, text);
      }),
      onSubmit: withBatchedUpdates(({ text, next }) => {
        this.submitHandler = null;
        this.setCellText(table.id, row, col, text);
        if (text !== startText) {
          app.store.scheduleCapture();
        }

        const latest = app.scene.getNonDeletedElement(table.id);
        if (next && latest && isTableElement(latest)) {
          // past the last row (Tab on the last cell): append one
          if (next.row >= getTableRowCount(latest)) {
            this.updateTable(
              latest,
              insertTableRow(latest, getTableRowCount(latest)),
            );
            app.store.scheduleCapture();
          }
          this.startCellEditing(latest, next.row, next.col);
          return;
        }

        flushSync(() => {
          app.setState((prevState) =>
            prevState.activeTableCell
              ? {
                  activeTableCell: {
                    ...prevState.activeTableCell,
                    editing: false,
                  },
                }
              : null,
          );
        });
        app.focusContainer();
      }),
    });
  }

  /** clears the text of the active cell, or of every cell of its row/column */
  private clearActiveCellText(table: ExcalidrawTableElement) {
    const cell = this.getActiveCell(table);
    if (!cell) {
      return;
    }
    const cells = table.cells.map((cells, row) =>
      cells.map((text, col) =>
        (cell.span === "col" || row === cell.row) &&
        (cell.span === "row" || col === cell.col)
          ? ""
          : text,
      ),
    );
    if (
      cells.every((cells, row) =>
        cells.every((t, col) => t === table.cells[row][col]),
      )
    ) {
      return;
    }
    this.app.store.scheduleCapture();
    this.updateTable(table, { cells });
  }

  // ---------------------------------------------------------------------------
  // keyboard
  // ---------------------------------------------------------------------------

  /** a key pressed with the canvas focused; returns whether it was handled */
  public handleKeyDown(event: KeyboardEvent | React.KeyboardEvent): boolean {
    const table = this.getSelectedTable();
    if (
      !table ||
      this.app.state.viewModeEnabled ||
      this.submitHandler ||
      !this.isCanvasKeyTarget(event.target)
    ) {
      return false;
    }
    const cell = this.getActiveCell(table);
    const hasModifier =
      event[KEYS.CTRL_OR_CMD] || event.altKey || event.metaKey;

    if (!cell) {
      if (event.key === KEYS.ENTER && !hasModifier && !event.shiftKey) {
        event.preventDefault();
        this.startCellEditing(table, 0, 0);
        return true;
      }
      return false;
    }

    if (event.key === KEYS.ESCAPE) {
      // the cell goes first, the table's selection is next
      event.preventDefault();
      this.clearActiveCell();
      return true;
    }
    if (hasModifier) {
      return false;
    }

    const arrow = {
      [KEYS.ARROW_LEFT]: [0, -1],
      [KEYS.ARROW_RIGHT]: [0, 1],
      [KEYS.ARROW_UP]: [-1, 0],
      [KEYS.ARROW_DOWN]: [1, 0],
    }[event.key];
    if (arrow) {
      // shift+arrows still nudge the table
      if (event.shiftKey) {
        return false;
      }
      event.preventDefault();
      this.moveActiveCell(table, arrow[0], arrow[1]);
      return true;
    }

    if (event.key === KEYS.TAB) {
      event.preventDefault();
      const rows = getTableRowCount(table);
      const cols = getTableColumnCount(table);
      const index =
        (cell.row * cols + cell.col + (event.shiftKey ? -1 : 1) + rows * cols) %
        (rows * cols);
      this.setActiveCell(table, Math.floor(index / cols), index % cols, "cell");
      return true;
    }

    if (event.key === KEYS.ENTER && !event.shiftKey) {
      event.preventDefault();
      this.startCellEditing(table, cell.row, cell.col);
      return true;
    }

    if (event.key === KEYS.DELETE || event.key === KEYS.BACKSPACE) {
      event.preventDefault();
      this.clearActiveCellText(table);
      return true;
    }

    // (space stays for panning)
    if (event.key.length === 1 && event.key !== KEYS.SPACE) {
      // typing replaces the cell's text
      event.preventDefault();
      this.startCellEditing(table, cell.row, cell.col, {
        initialValue: event.key,
      });
      return true;
    }
    return false;
  }

  /**
   * Keys go to the table only when the canvas has the focus, not a focused
   * UI control (a toolbar button, a menu item…) that handles them itself.
   */
  private isCanvasKeyTarget(target: EventTarget | null) {
    const { ownerDocument } = this.app;
    return (
      !target ||
      target === ownerDocument ||
      target === ownerDocument.body ||
      target === ownerDocument.documentElement ||
      target === this.app.excalidrawContainerValue.container ||
      (target as Element).tagName === "CANVAS"
    );
  }

  // ---------------------------------------------------------------------------
  // pointer
  // ---------------------------------------------------------------------------

  private canUseControls() {
    const { activeTool, viewModeEnabled } = this.app.state;
    return (
      !viewModeEnabled &&
      !this.app.state.newElement &&
      !this.app.state.selectionElement &&
      (activeTool.type === "selection" || activeTool.type === "lasso")
    );
  }

  /** hover feedback for the selected table: the control under the pointer */
  public updateHover(scenePoint: { x: number; y: number }) {
    const table = this.getSelectedTable();
    let control = null;
    let cursor: string | null = null;

    if (table && this.canUseControls() && !this.submitHandler) {
      const point = [scenePoint.x, scenePoint.y] as const;
      const zoom = this.app.state.zoom;
      control = getTableControlAtPoint(table, point, zoom);
      if (control) {
        cursor = "pointer";
      } else {
        const divider = getTableDividerAtPoint(table, point, zoom);
        if (divider) {
          cursor =
            divider.kind === "col" ? CURSOR_COL_RESIZE : CURSOR_ROW_RESIZE;
        }
      }
    }

    if (!isSameTableControl(control, this.app.state.hoveredTableControl)) {
      this.app.setState({ hoveredTableControl: control });
    }
    if (cursor) {
      this.app.cursor.set(cursor);
    }
  }

  /**
   * The press on a selected table's controls. Returns whether it was
   * consumed. A press on a cell is left to the selection (it may drag the
   * table), and makes that cell active if it turns out to be a click.
   */
  public handlePointerDown(
    event: React.PointerEvent<HTMLElement>,
    pointerDownState: PointerDownState,
  ): boolean {
    const table = this.getSelectedTable();
    if (
      !table ||
      !this.canUseControls() ||
      this.submitHandler ||
      event.button !== POINTER_BUTTON.MAIN
    ) {
      return false;
    }

    const point = [
      pointerDownState.origin.x,
      pointerDownState.origin.y,
    ] as const;
    const zoom = this.app.state.zoom;
    const control = getTableControlAtPoint(table, point, zoom);

    if (control) {
      if (control.kind === "col-grip") {
        this.setActiveCell(table, 0, control.index, "col");
      } else if (control.kind === "row-grip") {
        this.setActiveCell(table, control.index, 0, "row");
      } else {
        this.app.actionManager.executeAction(
          control.kind === "col-insert"
            ? actionTableInsertColumnLeft
            : actionTableInsertRowAbove,
          "ui",
          { elementId: table.id, index: control.index },
        );
      }
      return true;
    }

    const divider = getTableDividerAtPoint(table, point, zoom);
    if (divider) {
      this.startDividerDrag(table, divider, event);
      return true;
    }

    if (
      !event.shiftKey &&
      !event.altKey &&
      !event[KEYS.CTRL_OR_CMD] &&
      getTableCellAtPoint(table, point)
    ) {
      this.activateCellOnClick(table, pointerDownState);
    }
    return false;
  }

  /** a click (no drag) on a selected table's cell makes the cell active */
  private activateCellOnClick(
    table: NonDeleted<ExcalidrawTableElement>,
    pointerDownState: PointerDownState,
  ) {
    const ownerWindow = this.app.ownerWindow;
    const removeListeners = () => {
      ownerWindow.removeEventListener(EVENT.POINTER_UP, onPointerUp);
      ownerWindow.removeEventListener(EVENT.POINTER_CANCEL, removeListeners);
    };
    const onPointerUp = (upEvent: PointerEvent) => {
      removeListeners();
      if (pointerDownState.drag.hasOccurred) {
        return;
      }
      const latest = this.app.scene.getNonDeletedElement(table.id);
      if (!latest || !isTableElement(latest) || !this.getSelectedTable()) {
        return;
      }
      const { x, y } = viewportCoordsToSceneCoords(upEvent, this.app.state);
      const position = getTableCellAtPoint(latest, [x, y]);
      if (position) {
        this.setActiveCell(latest, position.row, position.col, "cell");
      }
    };
    ownerWindow.addEventListener(EVENT.POINTER_UP, onPointerUp);
    ownerWindow.addEventListener(EVENT.POINTER_CANCEL, removeListeners);
  }

  /** a divider drag resizes the column on its left, or the row above it */
  private startDividerDrag(
    table: NonDeleted<ExcalidrawTableElement>,
    divider: { kind: "col" | "row"; index: number },
    pointerDownEvent: React.PointerEvent<HTMLElement>,
  ) {
    const app = this.app;
    const ownerWindow = app.ownerWindow;
    let hasMoved = false;

    const onPointerMove = withBatchedUpdates((event: PointerEvent) => {
      const latest = app.scene.getNonDeletedElement(table.id);
      if (!latest || !isTableElement(latest)) {
        return;
      }
      const { x, y } = viewportCoordsToSceneCoords(event, app.state);
      const [localX, localY] = getTableLocalPoint(latest, [x, y]);
      const patch =
        divider.kind === "col"
          ? resizeTableColumn(
              latest,
              divider.index,
              localX - getTableColumnOffsets(latest)[divider.index],
            )
          : resizeTableRow(
              latest,
              divider.index,
              localY - getTableRowOffsets(latest)[divider.index],
            );
      hasMoved = true;
      this.updateTable(latest, patch);
    });

    const onPointerUp = withBatchedUpdates(() => {
      app.host.setPointerUp(null);
      ownerWindow.removeEventListener(EVENT.POINTER_MOVE, onPointerMove);
      ownerWindow.removeEventListener(EVENT.POINTER_UP, onPointerUp);
      ownerWindow.removeEventListener(EVENT.POINTER_CANCEL, onPointerUp);
      if (hasMoved) {
        app.store.scheduleCapture();
      }
      app.cursor.applyForTool();
      app.setState({ cursorButton: "up" });
    });

    app.host.setPointerUp(onPointerUp);
    ownerWindow.addEventListener(EVENT.POINTER_MOVE, onPointerMove);
    ownerWindow.addEventListener(EVENT.POINTER_UP, onPointerUp);
    // a cancelled drag keeps what it resized so far
    ownerWindow.addEventListener(EVENT.POINTER_CANCEL, onPointerUp);
    app.cursor.set(
      divider.kind === "col" ? CURSOR_COL_RESIZE : CURSOR_ROW_RESIZE,
    );
    pointerDownEvent.preventDefault();
  }

  /** a double-click on a selected table edits the cell under it */
  public handleDoubleClick(scenePoint: { x: number; y: number }): boolean {
    const table = this.app.scene
      .getSelectedElements(this.app.state)
      .find(isTableElement);
    if (!table || this.app.state.viewModeEnabled || table.locked) {
      return false;
    }
    const position = getTableCellAtPoint(table, [scenePoint.x, scenePoint.y]);
    if (!position) {
      return false;
    }
    this.startCellEditing(table, position.row, position.col);
    return true;
  }

  /** the context menu of a table acts on the cell, row or column under it */
  public prepareContextMenu(
    element: NonDeletedExcalidrawElement,
    scenePoint: { x: number; y: number },
  ) {
    if (!isTableElement(element)) {
      return;
    }
    const point = [scenePoint.x, scenePoint.y] as const;
    const control = getTableControlAtPoint(element, point, this.app.state.zoom);
    if (control?.kind === "col-grip") {
      this.setActiveCell(element, 0, control.index, "col");
    } else if (control?.kind === "row-grip") {
      this.setActiveCell(element, control.index, 0, "row");
    } else {
      const position = getTableCellAtPoint(element, point);
      if (position) {
        this.setActiveCell(element, position.row, position.col, "cell");
      }
    }
  }
}
