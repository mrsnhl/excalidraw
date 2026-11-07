import {
  CLASSES,
  TABLE_CELL_PADDING,
  KEYS,
  POINTER_BUTTON,
  THEME,
  applyDarkModeFilter,
  getFontFamilyString,
  isTestEnv,
  isWritableElement,
} from "@excalidraw/common";

import {
  getLineHeightInPx,
  getTableCellFont,
  getTableCellRect,
  getTableColumnCount,
  getTableRowCount,
  getWinningVariableElements,
  isTableHeaderRow,
  normalizeText,
  wrapText,
} from "@excalidraw/element";

import type { TableCellPosition } from "@excalidraw/element";
import type {
  ExcalidrawTableElement,
  NonDeleted,
} from "@excalidraw/element/types";

import { actionSaveFileToDisk, actionSaveToActiveFile } from "../actions";
import { attachVariableAutocomplete } from "../components/VariableAutocomplete";
import {
  actionResetZoom,
  actionZoomIn,
  actionZoomOut,
} from "../actions/actionCanvas";
import {
  actionDecreaseFontSize,
  actionIncreaseFontSize,
} from "../actions/actionProperties";
import { t } from "../i18n";

import type App from "../components/App";

type SubmitHandler = () => void;

/**
 * The in-place editor of one table cell. It edits the cell's raw text (any
 * `{{variable}}` placeholder stays unresolved) and covers the whole cell, so
 * the cell reads and grows the way the table draws it.
 *
 * Moving to another cell (Tab, or an arrow key at the edge of the text) ends
 * this editor and hands the target to `onSubmit`, which starts the next one.
 */
export const tableCellWysiwyg = ({
  onChange,
  onSubmit,
  getViewportCoords,
  element,
  row,
  col,
  canvas,
  excalidrawContainer,
  app,
  initialValue = null,
  autoSelect = true,
}: {
  onChange: (text: string) => void;
  onSubmit: (data: {
    viaKeyboard: boolean;
    text: string;
    next: TableCellPosition | null;
  }) => void;
  getViewportCoords: (x: number, y: number) => [number, number];
  element: ExcalidrawTableElement;
  row: number;
  col: number;
  canvas: HTMLCanvasElement | null;
  excalidrawContainer: HTMLDivElement | null;
  app: App;
  /** replaces the cell's text (typing a character on a selected cell) */
  initialValue?: string | null;
  autoSelect?: boolean;
}): SubmitHandler => {
  const { ownerDocument, ownerWindow } = app;
  const editorBox =
    excalidrawContainer?.querySelector<HTMLDivElement>(
      ".excalidraw-textEditorContainer",
    ) ?? null;

  /** keeps the editor's box off the sidebar, see `textWysiwyg` */
  const updateEditorBoxInsets = () => {
    if (!editorBox) {
      return 0;
    }
    const { left, right } = app.viewport.getSidebarInsets();
    editorBox.style.left = `${left}px`;
    editorBox.style.right = `${right}px`;
    return left;
  };

  const getTable = () =>
    app.scene.getElement<NonDeleted<ExcalidrawTableElement>>(element.id);

  let LAST_THEME = app.state.theme;

  const updateStyle = () => {
    LAST_THEME = app.state.theme;
    const table = getTable();
    if (!table || row >= table.rowHeights.length) {
      return;
    }
    if (col >= table.columnWidths.length) {
      return;
    }
    const { zoom, theme } = app.state;
    const cell = getTableCellRect(table, row, col);
    const font = getTableCellFont(table, isTableHeaderRow(table, row));
    const lineHeightPx = getLineHeightInPx(table.fontSize, table.lineHeight);

    const lineCount = editable.value
      ? wrapText(
          editable.value,
          font,
          Math.max(cell.width - TABLE_CELL_PADDING * 2, 1),
          app.renderEnvironment,
        ).split("\n").length
      : 1;
    const textHeight = lineCount * lineHeightPx;
    const freeHeight = cell.height - TABLE_CELL_PADDING * 2 - textHeight;
    const paddingTop =
      TABLE_CELL_PADDING +
      (table.verticalAlign === "top"
        ? 0
        : Math.max(
            table.verticalAlign === "bottom" ? freeHeight : freeHeight / 2,
            0,
          ));

    const [viewportX, viewportY] = getViewportCoords(
      table.x + table.width / 2,
      table.y + table.height / 2,
    );
    // the box is the cell; it rotates and scales about the table's center
    const originX = table.width / 2 - cell.x;
    const originY = table.height / 2 - cell.y;
    const editorBoxLeft = updateEditorBoxInsets();

    Object.assign(editable.style, {
      font,
      // must be defined *after* font
      lineHeight: table.lineHeight,
      width: `${cell.width}px`,
      height: `${cell.height}px`,
      padding: `${paddingTop}px ${TABLE_CELL_PADDING}px ${TABLE_CELL_PADDING}px`,
      left: `${viewportX - originX - editorBoxLeft}px`,
      top: `${viewportY - originY}px`,
      transformOrigin: `${originX}px ${originY}px`,
      transform: `scale(${zoom.value}) rotate(${
        (180 * table.angle) / Math.PI
      }deg)`,
      textAlign: table.textAlign,
      color: applyDarkModeFilter(table.strokeColor, theme === THEME.DARK),
      opacity: table.opacity / 100,
    });
    // the font shorthand doesn't set the family in jsdom
    if (isTestEnv()) {
      editable.style.fontFamily = getFontFamilyString(table);
    }
  };

  const editable = ownerDocument.createElement("textarea");

  editable.dir = "auto";
  editable.tabIndex = 0;
  editable.dataset.type = "wysiwyg";
  editable.setAttribute(
    "aria-label",
    t("labels.tableCell", { row: row + 1, column: col + 1 }),
  );
  editable.classList.add("excalidraw-wysiwyg", "excalidraw-table-cell-wysiwyg");
  editable.value = initialValue ?? element.cells[row]?.[col] ?? "";

  const detachVariableAutocomplete = attachVariableAutocomplete(editable, {
    getVariables: () =>
      getWinningVariableElements(app.scene.getVariableElements()),
  });

  Object.assign(editable.style, {
    position: "absolute",
    display: "block",
    boxSizing: "border-box",
    backfaceVisibility: "hidden",
    margin: 0,
    border: 0,
    outline: 0,
    resize: "none",
    background: "transparent",
    overflow: "hidden",
    // prevent line wrapping (`whitespace: nowrap` doesn't work on FF)
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    wordBreak: "break-word",
    // allow shrinking below the font's min height
    minHeight: "0",
  });

  const getNextCell = (delta: -1 | 1): TableCellPosition | null => {
    const table = getTable();
    if (!table) {
      return null;
    }
    const rows = getTableRowCount(table);
    const cols = getTableColumnCount(table);
    // Tab on the last cell goes to a new row (which the app appends)
    if (delta === 1 && row === rows - 1 && col === cols - 1) {
      return { row: rows, col: 0 };
    }
    const index = (row * cols + col + delta + rows * cols) % (rows * cols);
    return { row: Math.floor(index / cols), col: index % cols };
  };

  const getAdjacentCell = (
    dRow: number,
    dCol: number,
  ): TableCellPosition | null => {
    const table = getTable();
    if (!table) {
      return null;
    }
    const next = { row: row + dRow, col: col + dCol };
    return next.row >= 0 &&
      next.col >= 0 &&
      next.row < getTableRowCount(table) &&
      next.col < getTableColumnCount(table)
      ? next
      : null;
  };

  let isDestroyed = false;
  // like `textWysiwyg`: a state variable, so handlers share one callback
  let submittedViaKeyboard = false;
  let nextCell: TableCellPosition | null = null;

  const handleSubmit = () => {
    if (isDestroyed) {
      return;
    }
    isDestroyed = true;
    // cleanup must precede onSubmit, or the app's blur of the editor would
    // loop (blur -> onSubmit -> refocus -> blur)
    cleanup();
    onSubmit({
      viaKeyboard: submittedViaKeyboard,
      text: editable.value,
      next: nextCell,
    });
  };

  const moveTo = (next: TableCellPosition | null) => {
    if (!next) {
      return;
    }
    submittedViaKeyboard = true;
    nextCell = next;
    handleSubmit();
  };

  const stopEvent = (event: Event) => {
    if (event.target instanceof ownerWindow.HTMLCanvasElement) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  editable.oninput = () => {
    const normalized = normalizeText(editable.value);
    if (editable.value !== normalized) {
      const selectionStart = editable.selectionStart;
      editable.value = normalized;
      editable.selectionStart = selectionStart;
      editable.selectionEnd = selectionStart;
    }
    onChange(editable.value);
  };

  editable.onkeydown = (event) => {
    if (event.isComposing || event.keyCode === 229) {
      return;
    }
    const { selectionStart, selectionEnd, value } = editable;
    const atCaret = selectionStart === selectionEnd;
    const plainArrow =
      !event.shiftKey && !event.altKey && !event[KEYS.CTRL_OR_CMD];

    if (!event.shiftKey && actionZoomIn.keyTest(event)) {
      event.preventDefault();
      app.actionManager.executeAction(actionZoomIn);
      updateStyle();
    } else if (!event.shiftKey && actionZoomOut.keyTest(event)) {
      event.preventDefault();
      app.actionManager.executeAction(actionZoomOut);
      updateStyle();
    } else if (!event.shiftKey && actionResetZoom.keyTest(event)) {
      event.preventDefault();
      app.actionManager.executeAction(actionResetZoom);
      updateStyle();
    } else if (actionDecreaseFontSize.keyTest(event)) {
      app.actionManager.executeAction(actionDecreaseFontSize);
    } else if (actionIncreaseFontSize.keyTest(event)) {
      app.actionManager.executeAction(actionIncreaseFontSize);
    } else if (event.key === KEYS.ESCAPE) {
      event.preventDefault();
      submittedViaKeyboard = true;
      handleSubmit();
    } else if (actionSaveToActiveFile.keyTest(event)) {
      event.preventDefault();
      handleSubmit();
      app.actionManager.executeAction(actionSaveToActiveFile, "keyboard");
    } else if (actionSaveFileToDisk.keyTest(event)) {
      event.preventDefault();
      handleSubmit();
      app.actionManager.executeAction(actionSaveFileToDisk, "keyboard");
    } else if (event.key === KEYS.ENTER && event[KEYS.CTRL_OR_CMD]) {
      event.preventDefault();
      submittedViaKeyboard = true;
      handleSubmit();
    } else if (event.key === KEYS.TAB) {
      event.preventDefault();
      moveTo(getNextCell(event.shiftKey ? -1 : 1));
    } else if (plainArrow && atCaret) {
      // arrow keys leave the cell only from its edge
      const atStart = selectionStart === 0;
      const atEnd = selectionStart === value.length;
      const next =
        event.key === KEYS.ARROW_LEFT && atStart
          ? getAdjacentCell(0, -1)
          : event.key === KEYS.ARROW_RIGHT && atEnd
          ? getAdjacentCell(0, 1)
          : event.key === KEYS.ARROW_UP && atStart
          ? getAdjacentCell(-1, 0)
          : event.key === KEYS.ARROW_DOWN && atEnd
          ? getAdjacentCell(1, 0)
          : null;
      if (next) {
        event.preventDefault();
        moveTo(next);
      }
    }
  };

  const bindBlurEvent = (event?: MouseEvent) => {
    ownerWindow.removeEventListener("pointerup", bindBlurEvent);
    // deferred so that the pointerdown that started the editor (or picked a
    // color) doesn't blur it on the ensuing pointerup
    const target = event?.target;
    const inProperties =
      (target instanceof ownerWindow.HTMLElement ||
        target instanceof ownerWindow.SVGElement) &&
      (target.classList.contains("properties-trigger") ||
        !!target.closest(
          `.properties-content, .${CLASSES.SHAPE_ACTIONS_MENU}, .compact-shape-actions-island`,
        ));

    ownerWindow.setTimeout(() => {
      if (inProperties || isDestroyed) {
        return;
      }
      editable.onblur = handleSubmit;
      editable.focus({ preventScroll: true });
      if (initialValue === null && !autoSelect) {
        editable.setSelectionRange(
          editable.value.length,
          editable.value.length,
        );
      }
    });
  };

  const temporarilyDisableSubmit = () => {
    editable.onblur = null;
    ownerWindow.addEventListener("pointerup", bindBlurEvent);
    ownerWindow.addEventListener("blur", handleSubmit);
  };

  // prevent blur when changing properties from the menu
  const onPointerDown = (event: PointerEvent) => {
    const target = event.target;

    if (event.button === POINTER_BUTTON.WHEEL) {
      temporarilyDisableSubmit();
      if (target instanceof ownerWindow.HTMLTextAreaElement) {
        event.preventDefault();
        app.pan.start(event);
      }
      return;
    }

    const isPropertiesTrigger =
      target instanceof ownerWindow.HTMLElement &&
      target.classList.contains("properties-trigger");
    const isPropertiesContent =
      (target instanceof ownerWindow.HTMLElement ||
        target instanceof ownerWindow.SVGElement) &&
      !!(target as Element).closest(".properties-content");

    if (
      ((target instanceof ownerWindow.HTMLElement ||
        target instanceof ownerWindow.SVGElement) &&
        (target.closest(
          `.${CLASSES.SHAPE_ACTIONS_MENU}, .${CLASSES.ZOOM_ACTIONS}`,
        ) ||
          target.closest(".compact-shape-actions-island")) &&
        !isWritableElement(target)) ||
      isPropertiesTrigger ||
      isPropertiesContent
    ) {
      temporarilyDisableSubmit();
    } else if (
      target instanceof ownerWindow.HTMLCanvasElement &&
      // vitest ignores stopPropagation, capture-mode and rAF
      !isTestEnv()
    ) {
      // blur doesn't always fire on mobile: submit on a press outside too,
      // in the next frame so the press isn't also acted on as a new editor
      ownerWindow.requestAnimationFrame(() => {
        handleSubmit();
      });
    }
  };

  const unsubOnChange = app.onChangeEmitter.on(() => {
    if (app.state.theme !== LAST_THEME) {
      updateStyle();
    }
  });

  // follow the table: its size, position and font, and the live row heights
  const unbindUpdate = app.scene.onUpdate(() => {
    updateStyle();
    const isPopupOpened = !!ownerDocument.activeElement?.closest(
      ".properties-content",
    );
    if (!isPopupOpened) {
      editable.focus({ preventScroll: true });
    }
  });

  const unbindOnScroll = app.onScrollChangeEmitter.on(() => {
    updateStyle();
  });

  let observer: ResizeObserver | null = null;

  const cleanup = () => {
    editable.onblur = null;
    editable.oninput = null;
    editable.onkeydown = null;
    detachVariableAutocomplete();
    observer?.disconnect();
    ownerWindow.removeEventListener("resize", updateStyle);
    ownerWindow.removeEventListener("wheel", stopEvent, true);
    ownerWindow.removeEventListener("pointerdown", onPointerDown, {
      capture: true,
    });
    ownerWindow.removeEventListener("pointerup", bindBlurEvent);
    ownerWindow.removeEventListener("blur", handleSubmit);
    ownerWindow.removeEventListener("beforeunload", handleSubmit);
    unbindUpdate();
    unsubOnChange();
    unbindOnScroll();
    editorBox?.style.removeProperty("left");
    editorBox?.style.removeProperty("right");
    editable.remove();
  };

  updateStyle();
  if (initialValue !== null) {
    onChange(initialValue);
  }

  if (initialValue === null && autoSelect) {
    editable.select();
  }
  bindBlurEvent();

  if (canvas && "ResizeObserver" in ownerWindow) {
    observer = new ownerWindow.ResizeObserver(() => {
      updateStyle();
    });
    observer.observe(canvas);
  } else {
    ownerWindow.addEventListener("resize", updateStyle);
  }

  ownerWindow.addEventListener("wheel", stopEvent, {
    passive: false,
    capture: true,
  });

  editable.onpointerdown = (event) => event.stopPropagation();

  // rAF (+ capture): don't catch the pointerdown that started the editor
  ownerWindow.requestAnimationFrame(() => {
    if (!isDestroyed) {
      ownerWindow.addEventListener("pointerdown", onPointerDown, {
        capture: true,
      });
    }
  });
  ownerWindow.addEventListener("beforeunload", handleSubmit);
  editorBox!.appendChild(editable);
  // after mounting, so the caret lands past a typed first character
  if (initialValue !== null) {
    editable.setSelectionRange(editable.value.length, editable.value.length);
  }
  updateStyle();

  return handleSubmit;
};
