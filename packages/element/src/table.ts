import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  DEFAULT_TABLE_COLUMN_WIDTH,
  DEFAULT_TABLE_ROW_HEIGHT,
  MAX_TABLE_AUTO_COLUMN_WIDTH,
  MIN_TABLE_COLUMN_WIDTH,
  MIN_TABLE_ROW_HEIGHT,
  TABLE_CELL_PADDING,
  getFontString,
  getVerticalOffset,
  resolveVariables,
} from "@excalidraw/common";
import { clamp, pointFrom, pointRotateRads } from "@excalidraw/math";

import type { VariableMap } from "@excalidraw/common";
import type { GlobalPoint, Radians } from "@excalidraw/math";

import {
  getLineHeightInPx,
  getLineWidth,
  normalizeText,
} from "./textMeasurements";
import { wrapText } from "./textWrapping";
import { newTableElement } from "./newElement";

import type { RenderEnvironment } from "./renderEnvironment";
import type { ExcalidrawTableElement, FontString, NonDeleted } from "./types";

/** a table update, which never deletes (applies to deleted and live alike) */
export type TableUpdate = Omit<
  Partial<ExcalidrawTableElement>,
  "id" | "created" | "updated" | "isDeleted"
>;

export type TableCellPosition = { row: number; col: number };

export type TableCellLayout = {
  /** resolved and wrapped lines */
  lines: string[];
  textWidth: number;
  textHeight: number;
};

export type TableLayout = {
  /** column boundaries relative to the element's left edge, cols + 1 entries */
  colX: number[];
  /** row boundaries relative to the element's top edge, rows + 1 entries */
  rowY: number[];
  cells: TableCellLayout[][];
  /** height each row needs for its content, padding included */
  contentHeights: number[];
};

/** the fields every grid edit can change */
export type TableGridPatch = Pick<
  ExcalidrawTableElement,
  | "cells"
  | "columnWidths"
  | "rowBaseHeights"
  | "rowHeights"
  | "width"
  | "height"
>;

type TableGeometry = Pick<
  ExcalidrawTableElement,
  "x" | "y" | "width" | "height" | "angle"
>;

// -----------------------------------------------------------------------------
// layout
// -----------------------------------------------------------------------------

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

/** cumulative boundaries: [0, v0, v0 + v1, ...] */
const getOffsets = (sizes: readonly number[]) => {
  const offsets = [0];
  for (const size of sizes) {
    offsets.push(offsets[offsets.length - 1] + size);
  }
  return offsets;
};

export const getTableColumnOffsets = (
  element: Pick<ExcalidrawTableElement, "columnWidths">,
) => getOffsets(element.columnWidths);

export const getTableRowOffsets = (
  element: Pick<ExcalidrawTableElement, "rowHeights">,
) => getOffsets(element.rowHeights);

export const getTableRowCount = (
  element: Pick<ExcalidrawTableElement, "cells">,
) => element.cells.length;

export const getTableColumnCount = (
  element: Pick<ExcalidrawTableElement, "columnWidths">,
) => element.columnWidths.length;

export const getTableCellFont = (
  element: Pick<ExcalidrawTableElement, "fontSize" | "fontFamily">,
  bold = false,
): FontString => {
  const font = getFontString(element);
  return (bold ? `bold ${font}` : font) as FontString;
};

/** whether the cell text of `row` is drawn bold */
export const isTableHeaderRow = (
  element: Pick<ExcalidrawTableElement, "headerRow">,
  row: number,
) => element.headerRow && row === 0;

/** a version changes when fonts finish loading, so metrics are re-measured */
let layoutGeneration = 0;

/** drop all memoized layouts, e.g. after fonts were loaded */
export const invalidateTableLayouts = () => {
  layoutGeneration++;
};

type LayoutCacheEntry = {
  version: number;
  versionNonce: number;
  generation: number;
  variables: VariableMap | null;
  layout: TableLayout;
};

const layoutCache = new WeakMap<ExcalidrawTableElement, LayoutCacheEntry>();

const normalizeVariables = (variables: VariableMap | null | undefined) =>
  variables && variables.size ? variables : null;

const computeTableLayout = (
  element: ExcalidrawTableElement,
  variables: VariableMap | null,
  env?: RenderEnvironment,
): TableLayout => {
  const lineHeightPx = getLineHeightInPx(element.fontSize, element.lineHeight);
  const colX = getTableColumnOffsets(element);
  const rowY = getTableRowOffsets(element);
  const contentHeights: number[] = [];

  const cells = element.cells.map((rowCells, row) => {
    const font = getTableCellFont(element, isTableHeaderRow(element, row));
    let rowContentHeight = lineHeightPx;
    const layouts = rowCells.map((text, col) => {
      const maxWidth = Math.max(
        0,
        (element.columnWidths[col] ?? DEFAULT_TABLE_COLUMN_WIDTH) -
          TABLE_CELL_PADDING * 2,
      );
      const resolved = normalizeText(resolveVariables(text, variables));
      const lines = (
        resolved ? wrapText(resolved, font, maxWidth, env) : ""
      ).split("\n");
      const textHeight = lineHeightPx * lines.length;
      rowContentHeight = Math.max(rowContentHeight, textHeight);
      return {
        lines,
        textWidth: Math.max(
          ...lines.map((line) => (line ? getLineWidth(line, font, env) : 0)),
        ),
        textHeight,
      };
    });
    contentHeights.push(rowContentHeight + TABLE_CELL_PADDING * 2);
    return layouts;
  });

  return { colX, rowY, cells, contentHeights };
};

export type TableTextRun = {
  text: string;
  /** anchor, relative to the table's top-left (see `textAnchor`) */
  x: number;
  /** alphabetic baseline */
  y: number;
  textAnchor: "start" | "middle" | "end";
  row: number;
  col: number;
  bold: boolean;
  /** the cell the text is clipped to */
  clip: TableRect;
};

/** Every non-empty line of text a table draws, shared by canvas and SVG. */
export const getTableTextRuns = (
  element: ExcalidrawTableElement,
  layout: TableLayout,
): TableTextRun[] => {
  const lineHeightPx = getLineHeightInPx(element.fontSize, element.lineHeight);
  const baselineOffset = getVerticalOffset(
    element.fontFamily,
    element.fontSize,
    lineHeightPx,
  );
  const runs: TableTextRun[] = [];

  layout.cells.forEach((rowLayouts, row) => {
    rowLayouts.forEach((cellLayout, col) => {
      if (!cellLayout.lines.some(Boolean)) {
        return;
      }
      const clip: TableRect = {
        x: layout.colX[col],
        y: layout.rowY[row],
        width: element.columnWidths[col],
        height: element.rowHeights[row],
      };
      const top =
        element.verticalAlign === "top"
          ? TABLE_CELL_PADDING
          : element.verticalAlign === "bottom"
          ? clip.height - TABLE_CELL_PADDING - cellLayout.textHeight
          : (clip.height - cellLayout.textHeight) / 2;
      const [x, textAnchor] =
        element.textAlign === "center"
          ? ([clip.x + clip.width / 2, "middle"] as const)
          : element.textAlign === "right"
          ? ([clip.x + clip.width - TABLE_CELL_PADDING, "end"] as const)
          : ([clip.x + TABLE_CELL_PADDING, "start"] as const);

      cellLayout.lines.forEach((text, index) => {
        if (text) {
          runs.push({
            text,
            x,
            y: clip.y + top + index * lineHeightPx + baselineOffset,
            textAnchor,
            row,
            col,
            bold: isTableHeaderRow(element, row),
            clip,
          });
        }
      });
    });
  });
  return runs;
};

/**
 * Resolves, wraps and measures every cell. Memoized per element object (and
 * its version), so repeated calls from render, hit-testing and editing are
 * cheap. The variables map is compared by identity.
 */
export const getTableLayout = (
  element: ExcalidrawTableElement,
  variables?: VariableMap | null,
  env?: RenderEnvironment,
): TableLayout => {
  const vars = normalizeVariables(variables);
  const cached = layoutCache.get(element);
  if (
    cached &&
    cached.version === element.version &&
    cached.versionNonce === element.versionNonce &&
    cached.generation === layoutGeneration &&
    cached.variables === vars
  ) {
    return cached.layout;
  }
  const layout = computeTableLayout(element, vars, env);
  layoutCache.set(element, {
    version: element.version,
    versionNonce: element.versionNonce,
    generation: layoutGeneration,
    variables: vars,
    layout,
  });
  return layout;
};

/**
 * Returns the `rowHeights` and `height` that fit the current cells. Each row
 * is as tall as its user-set base height, or as its content if that is taller.
 * Apply the result with `scene.mutateElement`.
 */
export const refreshTableLayout = (
  element: ExcalidrawTableElement,
  variables?: VariableMap | null,
  env?: RenderEnvironment,
): Pick<ExcalidrawTableElement, "rowHeights" | "height"> => {
  const { contentHeights } = computeTableLayout(
    element,
    normalizeVariables(variables),
    env,
  );
  const rowHeights = element.cells.map((_, row) =>
    Math.max(
      element.rowBaseHeights[row] ?? DEFAULT_TABLE_ROW_HEIGHT,
      contentHeights[row],
    ),
  );
  const unchanged =
    rowHeights.length === element.rowHeights.length &&
    rowHeights.every((height, row) => height === element.rowHeights[row]);
  const nextRowHeights = unchanged ? element.rowHeights : rowHeights;
  return { rowHeights: nextRowHeights, height: sum(nextRowHeights) };
};

/**
 * Position that keeps the (rotated) top-left corner of a table in place when
 * its size changes, same as `resizeSingleElement` does for other elements.
 */
export const getTablePositionForResize = (
  element: TableGeometry,
  nextWidth: number,
  nextHeight: number,
): { x: number; y: number } => {
  const dw = nextWidth - element.width;
  const dh = nextHeight - element.height;
  if (!element.angle || (!dw && !dh)) {
    return { x: element.x, y: element.y };
  }
  const shift = pointRotateRads(
    pointFrom<GlobalPoint>(dw / 2, dh / 2),
    pointFrom<GlobalPoint>(0, 0),
    element.angle,
  );
  const cx = element.x + element.width / 2 + shift[0];
  const cy = element.y + element.height / 2 + shift[1];
  return { x: cx - nextWidth / 2, y: cy - nextHeight / 2 };
};

/**
 * Turns a grid edit into the complete element update: refreshes the row
 * heights against the new content, keeps `width`/`height` in sync with the
 * grid and keeps the rotated top-left corner fixed.
 */
export const getTableUpdate = (
  element: ExcalidrawTableElement,
  patch: TableUpdate,
  variables?: VariableMap | null,
  env?: RenderEnvironment,
): TableUpdate => {
  const merged = { ...element, ...patch } as ExcalidrawTableElement;
  const width = sum(merged.columnWidths);
  const refreshed = refreshTableLayout({ ...merged, width }, variables, env);
  return {
    ...patch,
    ...refreshed,
    width,
    ...getTablePositionForResize(element, width, refreshed.height),
  };
};

/**
 * Column widths that fit the widest cell line of each column (padding
 * included), clamped to a sensible range.
 */
export const getAutoTableColumnWidths = (
  cells: readonly (readonly string[])[],
  element: Pick<ExcalidrawTableElement, "fontSize" | "fontFamily">,
  headerRow = false,
  variables?: VariableMap | null,
  env?: RenderEnvironment,
) => {
  const columns = cells[0]?.length ?? 0;
  return Array.from({ length: columns }, (_, col) => {
    let widest = 0;
    cells.forEach((rowCells, row) => {
      const font = getTableCellFont(element, headerRow && row === 0);
      const text = normalizeText(resolveVariables(rowCells[col], variables));
      for (const line of text.split("\n")) {
        widest = Math.max(widest, line ? getLineWidth(line, font, env) : 0);
      }
    });
    return clamp(
      Math.ceil(widest + TABLE_CELL_PADDING * 2),
      MIN_TABLE_COLUMN_WIDTH,
      MAX_TABLE_AUTO_COLUMN_WIDTH,
    );
  });
};

/**
 * A table holding `cells`, with column widths measured from the content and
 * row heights refreshed (cells wider than the clamp wrap onto more lines).
 */
export const newTableElementFromCells = (
  opts: Omit<
    Parameters<typeof newTableElement>[0],
    "type" | "rows" | "columns" | "columnWidths" | "rowBaseHeights"
  > & {
    cells: readonly (readonly string[])[];
    variables?: VariableMap | null;
    renderEnvironment?: RenderEnvironment;
  },
): NonDeleted<ExcalidrawTableElement> => {
  const { variables, renderEnvironment, ...rest } = opts;
  const columnWidths = getAutoTableColumnWidths(
    opts.cells,
    {
      fontSize: opts.fontSize ?? DEFAULT_FONT_SIZE,
      fontFamily: opts.fontFamily ?? DEFAULT_FONT_FAMILY,
    },
    opts.headerRow,
    variables,
    renderEnvironment,
  );
  const table = newTableElement({ ...rest, type: "table", columnWidths });
  return {
    ...table,
    ...getTableUpdate(table, {}, variables, renderEnvironment),
  } as NonDeleted<ExcalidrawTableElement>;
};

// -----------------------------------------------------------------------------
// geometry
// -----------------------------------------------------------------------------

const findSpanIndex = (offsets: readonly number[], value: number) => {
  let low = 0;
  let high = offsets.length - 2;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid] <= value) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
};

/** scene point -> point relative to the table's unrotated top-left corner */
export const getTableLocalPoint = (
  element: TableGeometry,
  scenePoint: readonly [number, number],
): [number, number] => {
  const center = pointFrom<GlobalPoint>(
    element.x + element.width / 2,
    element.y + element.height / 2,
  );
  const [x, y] = pointRotateRads(
    pointFrom<GlobalPoint>(scenePoint[0], scenePoint[1]),
    center,
    -element.angle as Radians,
  );
  return [x - element.x, y - element.y];
};

/** inverse of `getTableLocalPoint` */
export const getTableScenePoint = (
  element: TableGeometry,
  localPoint: readonly [number, number],
): [number, number] => {
  const center = pointFrom<GlobalPoint>(
    element.x + element.width / 2,
    element.y + element.height / 2,
  );
  const [x, y] = pointRotateRads(
    pointFrom<GlobalPoint>(
      element.x + localPoint[0],
      element.y + localPoint[1],
    ),
    center,
    element.angle,
  );
  return [x, y];
};

export type TableRect = { x: number; y: number; width: number; height: number };

/** cell rect relative to the table's unrotated top-left corner */
export const getTableCellRect = (
  element: Pick<ExcalidrawTableElement, "columnWidths" | "rowHeights">,
  row: number,
  col: number,
): TableRect => {
  const colX = getTableColumnOffsets(element);
  const rowY = getTableRowOffsets(element);
  return {
    x: colX[col],
    y: rowY[row],
    width: element.columnWidths[col],
    height: element.rowHeights[row],
  };
};

/** rect of a whole row/column/cell span, relative to the table's top-left */
export const getTableSpanRect = (
  element: Pick<ExcalidrawTableElement, "columnWidths" | "rowHeights">,
  row: number,
  col: number,
  span: "cell" | "row" | "col",
): TableRect => {
  const cell = getTableCellRect(element, row, col);
  if (span === "row") {
    return {
      x: 0,
      y: cell.y,
      width: sum(element.columnWidths),
      height: cell.height,
    };
  }
  if (span === "col") {
    return {
      x: cell.x,
      y: 0,
      width: cell.width,
      height: sum(element.rowHeights),
    };
  }
  return cell;
};

export const getTableCellAtPoint = (
  element: ExcalidrawTableElement,
  scenePoint: readonly [number, number],
): TableCellPosition | null => {
  const [x, y] = getTableLocalPoint(element, scenePoint);
  if (x < 0 || y < 0 || x > element.width || y > element.height) {
    return null;
  }
  return {
    row: findSpanIndex(getTableRowOffsets(element), y),
    col: findSpanIndex(getTableColumnOffsets(element), x),
  };
};

export type TableDivider = { kind: "col" | "row"; index: number };

/** tolerance in px around dividers */
export const TABLE_DIVIDER_HIT_TOLERANCE = 8;

/**
 * Finds the column/row divider under the point: the inner dividers and the
 * right and bottom edges. `index` is the column/row to the left/above of the
 * divider, i.e. the one that is resized when it is dragged.
 */
export const getTableDividerAtPoint = (
  element: ExcalidrawTableElement,
  scenePoint: readonly [number, number],
  zoom: { value: number },
): TableDivider | null => {
  const tolerance = TABLE_DIVIDER_HIT_TOLERANCE / zoom.value;
  const [x, y] = getTableLocalPoint(element, scenePoint);
  const colX = getTableColumnOffsets(element);
  const rowY = getTableRowOffsets(element);

  let best: (TableDivider & { distance: number }) | null = null;

  if (y >= -tolerance && y <= element.height + tolerance) {
    for (let index = 0; index < colX.length - 1; index++) {
      const distance = Math.abs(x - colX[index + 1]);
      if (distance <= tolerance && (!best || distance < best.distance)) {
        best = { kind: "col", index, distance };
      }
    }
  }
  if (x >= -tolerance && x <= element.width + tolerance) {
    for (let index = 0; index < rowY.length - 1; index++) {
      const distance = Math.abs(y - rowY[index + 1]);
      if (distance <= tolerance && (!best || distance < best.distance)) {
        best = { kind: "row", index, distance };
      }
    }
  }
  return best && { kind: best.kind, index: best.index };
};

// -----------------------------------------------------------------------------
// on-canvas controls (grips and insert handles)
// -----------------------------------------------------------------------------

export const TABLE_GRIP_THICKNESS = 10;
export const TABLE_GRIP_MAX_LENGTH_COL = 32;
export const TABLE_GRIP_MAX_LENGTH_ROW = 28;
/** gap between the table edge and the grips */
export const TABLE_GRIP_GAP = 10;
export const TABLE_INSERT_DOT_SIZE = 6;
export const TABLE_INSERT_BUTTON_SIZE = 20;

export type TableControl =
  | { kind: "col-grip"; index: number }
  | { kind: "row-grip"; index: number }
  /** index is the boundary: 0 inserts before the first column/row */
  | { kind: "col-insert"; index: number }
  | { kind: "row-insert"; index: number };

export const isSameTableControl = (
  a: TableControl | null | undefined,
  b: TableControl | null | undefined,
) => (!a && !b) || (!!a && !!b && a.kind === b.kind && a.index === b.index);

export type TableControlGeometry = {
  colGrips: TableRect[];
  rowGrips: TableRect[];
  /** centers of the insert handles, relative to the table's top-left */
  colInserts: [number, number][];
  rowInserts: [number, number][];
  insertRadius: number;
};

/**
 * Geometry of the grips and insert handles relative to the table's unrotated
 * top-left corner, sized in screen pixels (divided by zoom).
 */
export const getTableControlGeometry = (
  element: Pick<ExcalidrawTableElement, "columnWidths" | "rowHeights">,
  zoom: { value: number },
): TableControlGeometry => {
  const px = 1 / zoom.value;
  const colX = getTableColumnOffsets(element);
  const rowY = getTableRowOffsets(element);
  const offset = (TABLE_GRIP_GAP + TABLE_GRIP_THICKNESS) * px;
  const handleOffset = (TABLE_GRIP_GAP + TABLE_GRIP_THICKNESS / 2) * px;

  const colGrips = element.columnWidths.map((width, index) => {
    const length = clamp(
      width - 20 * px,
      10 * px,
      TABLE_GRIP_MAX_LENGTH_COL * px,
    );
    return {
      x: colX[index] + (width - length) / 2,
      y: -offset,
      width: length,
      height: TABLE_GRIP_THICKNESS * px,
    };
  });
  const rowGrips = element.rowHeights.map((height, index) => {
    const length = clamp(
      height - 20 * px,
      10 * px,
      TABLE_GRIP_MAX_LENGTH_ROW * px,
    );
    return {
      x: -offset,
      y: rowY[index] + (height - length) / 2,
      width: TABLE_GRIP_THICKNESS * px,
      height: length,
    };
  });

  return {
    colGrips,
    rowGrips,
    colInserts: colX.map((x) => [x, -handleOffset]),
    rowInserts: rowY.map((y) => [-handleOffset, y]),
    insertRadius: (TABLE_INSERT_BUTTON_SIZE / 2) * px,
  };
};

const isInRect = (x: number, y: number, rect: TableRect, margin: number) =>
  x >= rect.x - margin &&
  x <= rect.x + rect.width + margin &&
  y >= rect.y - margin &&
  y <= rect.y + rect.height + margin;

/** which grip / insert handle (if any) is under the scene point */
export const getTableControlAtPoint = (
  element: ExcalidrawTableElement,
  scenePoint: readonly [number, number],
  zoom: { value: number },
): TableControl | null => {
  const [x, y] = getTableLocalPoint(element, scenePoint);
  const geometry = getTableControlGeometry(element, zoom);
  const margin = 2 / zoom.value;

  let best: { control: TableControl; distance: number } | null = null;
  const consider = (control: TableControl, [cx, cy]: [number, number]) => {
    const distance = Math.hypot(x - cx, y - cy);
    if (
      distance <= geometry.insertRadius &&
      (!best || distance < best.distance)
    ) {
      best = { control, distance };
    }
  };
  geometry.colInserts.forEach((center, index) =>
    consider({ kind: "col-insert", index }, center),
  );
  geometry.rowInserts.forEach((center, index) =>
    consider({ kind: "row-insert", index }, center),
  );
  if (best) {
    return (best as { control: TableControl }).control;
  }

  for (let index = 0; index < geometry.colGrips.length; index++) {
    if (isInRect(x, y, geometry.colGrips[index], margin)) {
      return { kind: "col-grip", index };
    }
  }
  for (let index = 0; index < geometry.rowGrips.length; index++) {
    if (isInRect(x, y, geometry.rowGrips[index], margin)) {
      return { kind: "row-grip", index };
    }
  }
  return null;
};

// -----------------------------------------------------------------------------
// grid edits (pure, return new arrays)
// -----------------------------------------------------------------------------

export const getTableGridPatch = (
  element: ExcalidrawTableElement,
): TableGridPatch => ({
  cells: element.cells,
  columnWidths: element.columnWidths,
  rowBaseHeights: element.rowBaseHeights,
  rowHeights: element.rowHeights,
  width: element.width,
  height: element.height,
});

const insertAt = <T>(values: readonly T[], at: number, value: T): T[] => {
  const index = clamp(at, 0, values.length);
  return [...values.slice(0, index), value, ...values.slice(index)];
};

const removeAt = <T>(values: readonly T[], at: number): T[] =>
  values.filter((_, index) => index !== at);

/** inserts an empty row before `at` (`at === rows` appends) */
export const insertTableRow = (
  element: ExcalidrawTableElement,
  at: number,
): TableGridPatch => {
  const rowHeights = insertAt(element.rowHeights, at, DEFAULT_TABLE_ROW_HEIGHT);
  return {
    cells: insertAt(
      element.cells,
      at,
      element.columnWidths.map(() => ""),
    ),
    columnWidths: element.columnWidths,
    rowBaseHeights: insertAt(
      element.rowBaseHeights,
      at,
      DEFAULT_TABLE_ROW_HEIGHT,
    ),
    rowHeights,
    width: element.width,
    height: sum(rowHeights),
  };
};

export const canDeleteTableRow = (element: ExcalidrawTableElement) =>
  element.cells.length > 1;

export const deleteTableRow = (
  element: ExcalidrawTableElement,
  at: number,
): TableGridPatch => {
  if (!canDeleteTableRow(element) || at < 0 || at >= element.cells.length) {
    return getTableGridPatch(element);
  }
  const rowHeights = removeAt(element.rowHeights, at);
  return {
    cells: removeAt(element.cells, at),
    columnWidths: element.columnWidths,
    rowBaseHeights: removeAt(element.rowBaseHeights, at),
    rowHeights,
    width: element.width,
    height: sum(rowHeights),
  };
};

/** inserts an empty column before `at` (`at === columns` appends) */
export const insertTableColumn = (
  element: ExcalidrawTableElement,
  at: number,
): TableGridPatch => {
  const index = clamp(at, 0, element.columnWidths.length);
  const neighbor =
    element.columnWidths[
      Math.max(0, Math.min(index - 1, element.columnWidths.length - 1))
    ] ?? DEFAULT_TABLE_COLUMN_WIDTH;
  const columnWidths = insertAt(element.columnWidths, index, neighbor);
  return {
    cells: element.cells.map((row) => insertAt(row, index, "")),
    columnWidths,
    rowBaseHeights: element.rowBaseHeights,
    rowHeights: element.rowHeights,
    width: sum(columnWidths),
    height: element.height,
  };
};

export const canDeleteTableColumn = (element: ExcalidrawTableElement) =>
  element.columnWidths.length > 1;

export const deleteTableColumn = (
  element: ExcalidrawTableElement,
  at: number,
): TableGridPatch => {
  if (
    !canDeleteTableColumn(element) ||
    at < 0 ||
    at >= element.columnWidths.length
  ) {
    return getTableGridPatch(element);
  }
  const columnWidths = removeAt(element.columnWidths, at);
  return {
    cells: element.cells.map((row) => removeAt(row, at)),
    columnWidths,
    rowBaseHeights: element.rowBaseHeights,
    rowHeights: element.rowHeights,
    width: sum(columnWidths),
    height: element.height,
  };
};

export const setTableCell = (
  element: Pick<ExcalidrawTableElement, "cells">,
  row: number,
  col: number,
  text: string,
): Pick<ExcalidrawTableElement, "cells"> => ({
  cells: element.cells.map((cells, r) =>
    r === row ? cells.map((cell, c) => (c === col ? text : cell)) : cells,
  ),
});

export const resizeTableColumn = (
  element: Pick<ExcalidrawTableElement, "columnWidths">,
  index: number,
  width: number,
): Pick<ExcalidrawTableElement, "columnWidths" | "width"> => {
  const columnWidths = element.columnWidths.map((current, i) =>
    i === index ? Math.max(MIN_TABLE_COLUMN_WIDTH, width) : current,
  );
  return { columnWidths, width: sum(columnWidths) };
};

export const resizeTableRow = (
  element: Pick<ExcalidrawTableElement, "rowBaseHeights">,
  index: number,
  baseHeight: number,
): Pick<ExcalidrawTableElement, "rowBaseHeights"> => ({
  rowBaseHeights: element.rowBaseHeights.map((current, i) =>
    i === index ? Math.max(MIN_TABLE_ROW_HEIGHT, baseHeight) : current,
  ),
});

/**
 * Scales the grid to a new outer size (columns and base heights by the same
 * ratio). The caller refreshes the layout afterwards.
 */
export const scaleTableGrid = (
  element: Pick<
    ExcalidrawTableElement,
    "columnWidths" | "rowBaseHeights" | "width" | "height"
  >,
  nextWidth: number,
  nextHeight: number,
): Pick<ExcalidrawTableElement, "columnWidths" | "rowBaseHeights"> => {
  const widthRatio = element.width ? nextWidth / element.width : 1;
  const heightRatio = element.height ? nextHeight / element.height : 1;
  return {
    columnWidths: element.columnWidths.map((width) =>
      Math.max(MIN_TABLE_COLUMN_WIDTH, width * widthRatio),
    ),
    rowBaseHeights: element.rowBaseHeights.map((height) =>
      Math.max(MIN_TABLE_ROW_HEIGHT, height * heightRatio),
    ),
  };
};

/**
 * Resizes the table to a dragged outer size. The grid decides the final size:
 * columns and row minimums scale with the drag, the row heights then grow to
 * fit their content.
 */
export const getResizedTableGrid = (
  orig: ExcalidrawTableElement,
  latest: ExcalidrawTableElement,
  nextWidth: number,
  nextHeight: number,
  variables?: VariableMap | null,
  env?: RenderEnvironment,
) => {
  const scaledGrid = scaleTableGrid(orig, nextWidth, nextHeight);
  const width = scaledGrid.columnWidths.reduce((a, b) => a + b, 0);
  const { rowHeights, height } = refreshTableLayout(
    { ...latest, ...scaledGrid, width },
    variables,
    env,
  );
  return { width, height, grid: { ...scaledGrid, rowHeights } };
};

/** equal split of `total` into `count` parts */
export const splitTableSize = (total: number, count: number) =>
  Array.from({ length: count }, () => total / count);

/** the table as TSV; tabs and newlines inside cells become spaces */
export const getTableAsTSV = (
  element: ExcalidrawTableElement,
  variables?: VariableMap | null,
) =>
  element.cells
    .map((row) =>
      row
        .map((cell) =>
          resolveVariables(cell, variables).replace(/[\t\r\n]+/g, " "),
        )
        .join("\t"),
    )
    .join("\n");
