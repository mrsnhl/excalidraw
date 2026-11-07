import {
  DEFAULT_TABLE_COLUMN_WIDTH,
  DEFAULT_TABLE_ROW_HEIGHT,
  MAX_TABLE_AUTO_COLUMN_WIDTH,
  MIN_TABLE_COLUMN_WIDTH,
  MIN_TABLE_ROW_HEIGHT,
} from "@excalidraw/common";

import type { VariableMap } from "@excalidraw/common";

import { newTableElement } from "../src/newElement";
import {
  canDeleteTableColumn,
  canDeleteTableRow,
  deleteTableColumn,
  deleteTableRow,
  getTableAsTSV,
  getTableCellAtPoint,
  getTableColumnOffsets,
  getTableControlAtPoint,
  getTableControlGeometry,
  getTableDividerAtPoint,
  getTableLayout,
  getTableRowOffsets,
  getTableScenePoint,
  getTableSpanRect,
  getTableUpdate,
  insertTableColumn,
  insertTableRow,
  newTableElementFromCells,
  refreshTableLayout,
  resizeTableColumn,
  resizeTableRow,
  scaleTableGrid,
} from "../src/table";

const createTable = (
  opts: Parameters<typeof newTableElement>[0] | object = {},
) =>
  newTableElement({
    type: "table",
    x: 100,
    y: 50,
    rows: 3,
    columns: 2,
    ...opts,
  } as Parameters<typeof newTableElement>[0]);

const variables: VariableMap = new Map([
  ["name", "Excalidraw"],
  ["long", "word ".repeat(40).trim()],
]);

describe("table element", () => {
  describe("newTableElement", () => {
    it("creates an empty grid with default sizes", () => {
      const table = createTable();
      expect(table.cells).toEqual([
        ["", ""],
        ["", ""],
        ["", ""],
      ]);
      expect(table.columnWidths).toEqual([
        DEFAULT_TABLE_COLUMN_WIDTH,
        DEFAULT_TABLE_COLUMN_WIDTH,
      ]);
      expect(table.rowHeights).toEqual(Array(3).fill(DEFAULT_TABLE_ROW_HEIGHT));
      expect(table.width).toBe(2 * DEFAULT_TABLE_COLUMN_WIDTH);
      expect(table.height).toBe(3 * DEFAULT_TABLE_ROW_HEIGHT);
      expect(table.headerRow).toBe(false);
    });

    it("takes the grid size from `cells`", () => {
      const table = createTable({ cells: [["a", "b", "c"]] });
      expect(table.cells).toEqual([["a", "b", "c"]]);
      expect(table.columnWidths).toHaveLength(3);
      expect(table.rowHeights).toHaveLength(1);
    });
  });

  describe("layout", () => {
    it("keeps the base height when the content fits", () => {
      const table = createTable({ cells: [["a", "b"]] });
      expect(refreshTableLayout(table).rowHeights).toEqual([
        DEFAULT_TABLE_ROW_HEIGHT,
      ]);
    });

    it("grows a row to fit wrapped content", () => {
      const table = createTable({
        cells: [["a", "word ".repeat(40).trim()]],
      });
      const { rowHeights, height } = refreshTableLayout(table);
      expect(rowHeights[0]).toBeGreaterThan(DEFAULT_TABLE_ROW_HEIGHT);
      expect(height).toBe(rowHeights[0]);
    });

    it("never shrinks below the base height", () => {
      const table = createTable({
        cells: [["a"]],
        rowBaseHeights: [100],
      });
      expect(refreshTableLayout(table).rowHeights).toEqual([100]);
    });

    it("resolves variables in the layout, not in the stored text", () => {
      const table = createTable({
        cells: [["{{name}}", "{{missing}}"]],
      });
      const layout = getTableLayout(table, variables);
      expect(layout.cells[0][0].lines).toEqual(["Excalidraw"]);
      // unknown names stay as written
      expect(layout.cells[0][1].lines).toEqual(["{{missing}}"]);
      expect(table.cells[0][0]).toBe("{{name}}");
    });

    it("sizes rows from the resolved text", () => {
      const table = createTable({ cells: [["{{long}}", ""]] });
      const withoutVariables = refreshTableLayout(table).rowHeights[0];
      const withVariables = refreshTableLayout(table, variables).rowHeights[0];
      expect(withVariables).toBeGreaterThan(withoutVariables);
    });

    it("memoizes per element, version and variables map", () => {
      const table = createTable({ cells: [["{{name}}", ""]] });
      expect(getTableLayout(table, variables)).toBe(
        getTableLayout(table, variables),
      );
      const other = new Map(variables);
      expect(getTableLayout(table, other)).not.toBe(
        getTableLayout(table, variables),
      );
      // an empty map is the same as no variables
      expect(getTableLayout(table, new Map())).toBe(
        getTableLayout(table, null),
      );
    });
  });

  describe("getTableUpdate", () => {
    it("keeps width and height in sync with the grid", () => {
      const table = createTable();
      const update = getTableUpdate(table, {
        columnWidths: [50, 70],
        rowBaseHeights: [40, 40, 40],
      });
      expect(update.width).toBe(120);
      expect(update.height).toBe(120);
      expect(update.rowHeights).toEqual([40, 40, 40]);
    });

    it("keeps the top-left corner of a rotated table in place", () => {
      const table = createTable({ angle: Math.PI / 3 });
      const corner = getTableScenePoint(table, [0, 0]);
      const update = getTableUpdate(table, { columnWidths: [200, 200] });
      const next = { ...table, ...update };
      const nextCorner = getTableScenePoint(next as typeof table, [0, 0]);
      expect(nextCorner[0]).toBeCloseTo(corner[0]);
      expect(nextCorner[1]).toBeCloseTo(corner[1]);
    });
  });

  describe("grid edits", () => {
    it("inserts a row at a boundary", () => {
      const table = createTable({
        cells: [
          ["a", "b"],
          ["c", "d"],
        ],
      });
      const patch = insertTableRow(table, 1);
      expect(patch.cells).toEqual([
        ["a", "b"],
        ["", ""],
        ["c", "d"],
      ]);
      expect(patch.rowHeights).toHaveLength(3);
      expect(patch.rowBaseHeights).toHaveLength(3);
      expect(patch.height).toBe(3 * DEFAULT_TABLE_ROW_HEIGHT);
      expect(insertTableRow(table, 2).cells[2]).toEqual(["", ""]);
      expect(insertTableRow(table, 0).cells[0]).toEqual(["", ""]);
    });

    it("inserts a column next to a neighbour's width", () => {
      const table = createTable({
        cells: [["a", "b"]],
        columnWidths: [50, 90],
      });
      const patch = insertTableColumn(table, 1);
      expect(patch.cells).toEqual([["a", "", "b"]]);
      expect(patch.columnWidths).toEqual([50, 50, 90]);
      expect(patch.width).toBe(190);
    });

    it("deletes rows and columns, but never the last one", () => {
      const table = createTable({
        cells: [
          ["a", "b"],
          ["c", "d"],
        ],
      });
      expect(deleteTableRow(table, 0).cells).toEqual([["c", "d"]]);
      expect(deleteTableColumn(table, 1).cells).toEqual([["a"], ["c"]]);

      const single = createTable({ cells: [["a"]] });
      expect(canDeleteTableRow(single)).toBe(false);
      expect(canDeleteTableColumn(single)).toBe(false);
      expect(deleteTableRow(single, 0).cells).toEqual([["a"]]);
      expect(deleteTableColumn(single, 0).cells).toEqual([["a"]]);
    });

    it("clamps column and row resizing to the minimum", () => {
      const table = createTable();
      expect(resizeTableColumn(table, 0, 1).columnWidths[0]).toBe(
        MIN_TABLE_COLUMN_WIDTH,
      );
      expect(resizeTableColumn(table, 0, 200)).toMatchObject({
        columnWidths: [200, DEFAULT_TABLE_COLUMN_WIDTH],
        width: 200 + DEFAULT_TABLE_COLUMN_WIDTH,
      });
      expect(resizeTableRow(table, 1, 1).rowBaseHeights[1]).toBe(
        MIN_TABLE_ROW_HEIGHT,
      );
    });

    it("scales the grid with the outer size", () => {
      const table = createTable();
      const scaled = scaleTableGrid(table, table.width * 2, table.height * 2);
      expect(scaled.columnWidths).toEqual([
        DEFAULT_TABLE_COLUMN_WIDTH * 2,
        DEFAULT_TABLE_COLUMN_WIDTH * 2,
      ]);
      expect(scaled.rowBaseHeights).toEqual(
        Array(3).fill(DEFAULT_TABLE_ROW_HEIGHT * 2),
      );
    });
  });

  describe("hit testing", () => {
    it("finds the cell under a point", () => {
      const table = createTable();
      expect(getTableCellAtPoint(table, [101, 51])).toEqual({ row: 0, col: 0 });
      expect(
        getTableCellAtPoint(table, [
          100 + DEFAULT_TABLE_COLUMN_WIDTH + 5,
          50 + 2 * DEFAULT_TABLE_ROW_HEIGHT + 5,
        ]),
      ).toEqual({ row: 2, col: 1 });
      expect(getTableCellAtPoint(table, [90, 51])).toBeNull();
    });

    it("finds cells of a rotated table", () => {
      const table = createTable({ angle: Math.PI / 2 });
      const point = getTableScenePoint(table, [
        DEFAULT_TABLE_COLUMN_WIDTH + 10,
        DEFAULT_TABLE_ROW_HEIGHT + 10,
      ]);
      expect(getTableCellAtPoint(table, point)).toEqual({ row: 1, col: 1 });
    });

    it("finds dividers within a zoom-independent tolerance", () => {
      const table = createTable();
      const x = 100 + DEFAULT_TABLE_COLUMN_WIDTH;
      expect(getTableDividerAtPoint(table, [x + 3, 70], { value: 1 })).toEqual({
        kind: "col",
        index: 0,
      });
      expect(getTableDividerAtPoint(table, [x + 6, 70], { value: 1 })).toEqual({
        kind: "col",
        index: 0,
      });
      // 6 scene units are 12 screen pixels at 2x
      expect(
        getTableDividerAtPoint(table, [x + 6, 70], { value: 2 }),
      ).toBeNull();
      expect(
        getTableDividerAtPoint(table, [150, 50 + DEFAULT_TABLE_ROW_HEIGHT], {
          value: 1,
        }),
      ).toEqual({ kind: "row", index: 0 });
    });

    it("finds grips and insert handles", () => {
      const table = createTable();
      const zoom = { value: 1 };
      const geometry = getTableControlGeometry(table, zoom);
      const toScene = ([x, y]: [number, number]) =>
        [table.x + x, table.y + y] as [number, number];

      expect(
        getTableControlAtPoint(table, toScene(geometry.colInserts[1]), zoom),
      ).toEqual({ kind: "col-insert", index: 1 });
      expect(
        getTableControlAtPoint(table, toScene(geometry.rowInserts[2]), zoom),
      ).toEqual({ kind: "row-insert", index: 2 });

      const grip = geometry.colGrips[1];
      expect(
        getTableControlAtPoint(
          table,
          toScene([grip.x + grip.width / 2, grip.y + grip.height / 2]),
          zoom,
        ),
      ).toEqual({ kind: "col-grip", index: 1 });
      const rowGrip = geometry.rowGrips[0];
      expect(
        getTableControlAtPoint(
          table,
          toScene([
            rowGrip.x + rowGrip.width / 2,
            rowGrip.y + rowGrip.height / 2,
          ]),
          zoom,
        ),
      ).toEqual({ kind: "row-grip", index: 0 });
      expect(getTableControlAtPoint(table, [150, 70], zoom)).toBeNull();
    });

    it("keeps the controls the same screen size at any zoom", () => {
      const table = createTable();
      const at1 = getTableControlGeometry(table, { value: 1 });
      const at2 = getTableControlGeometry(table, { value: 2 });
      expect(at2.colGrips[0].height).toBeCloseTo(at1.colGrips[0].height / 2);
      expect(at2.insertRadius).toBeCloseTo(at1.insertRadius / 2);
    });
  });

  describe("geometry helpers", () => {
    it("computes offsets and span rects", () => {
      const table = createTable({
        cells: [
          ["a", "b"],
          ["c", "d"],
        ],
        columnWidths: [50, 70],
        rowBaseHeights: [30, 40],
      });
      expect(getTableColumnOffsets(table)).toEqual([0, 50, 120]);
      expect(getTableRowOffsets(table)).toEqual([0, 30, 70]);
      expect(getTableSpanRect(table, 1, 1, "cell")).toEqual({
        x: 50,
        y: 30,
        width: 70,
        height: 40,
      });
      expect(getTableSpanRect(table, 1, 1, "row")).toEqual({
        x: 0,
        y: 30,
        width: 120,
        height: 40,
      });
      expect(getTableSpanRect(table, 1, 1, "col")).toEqual({
        x: 50,
        y: 0,
        width: 70,
        height: 70,
      });
    });
  });

  describe("TSV", () => {
    it("exports resolved text with tabs and newlines flattened", () => {
      const table = createTable({
        cells: [
          ["{{name}}", "a\tb"],
          ["line 1\nline 2", ""],
        ],
      });
      expect(getTableAsTSV(table, variables)).toBe(
        "Excalidraw\ta b\nline 1 line 2\t",
      );
      expect(getTableAsTSV(table)).toBe("{{name}}\ta b\nline 1 line 2\t");
    });
  });

  describe("newTableElementFromCells", () => {
    it("measures column widths from the content within the clamp", () => {
      const table = newTableElementFromCells({
        x: 0,
        y: 0,
        cells: [
          ["a", "a much longer cell"],
          ["bb", "x"],
          ["ccc", "word ".repeat(100)],
        ],
      });
      const [first, second] = table.columnWidths;
      expect(first).toBeGreaterThanOrEqual(MIN_TABLE_COLUMN_WIDTH);
      expect(second).toBeGreaterThan(first);
      expect(second).toBe(MAX_TABLE_AUTO_COLUMN_WIDTH);
      // the long cell wrapped, so its row grew
      expect(table.rowHeights[2]).toBeGreaterThan(DEFAULT_TABLE_ROW_HEIGHT);
      expect(table.height).toBe(
        table.rowHeights.reduce((sum, height) => sum + height, 0),
      );
      expect(table.width).toBe(first + second);
    });
  });
});
