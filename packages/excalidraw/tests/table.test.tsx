import React from "react";
import { vi } from "vitest";

import {
  DEFAULT_TABLE_COLUMNS,
  DEFAULT_TABLE_COLUMN_WIDTH,
  DEFAULT_TABLE_ROWS,
  DEFAULT_TABLE_ROW_HEIGHT,
  KEYS,
} from "@excalidraw/common";
import {
  getTableControlGeometry,
  getTableScenePoint,
} from "@excalidraw/element";

import { CaptureUpdateAction } from "@excalidraw/element";

import type { ExcalidrawTableElement } from "@excalidraw/element/types";

import type { FractionalIndex } from "@excalidraw/element/types";

import { createPasteEvent } from "../clipboard";
import { copyText } from "../actions/actionClipboard";
import {
  actionTableDeleteColumn,
  actionTableDeleteRow,
  actionTableInsertColumnRight,
  actionTableInsertRowBelow,
  actionToggleTableHeaderRow,
} from "../actions/actionTable";
import { Fonts } from "../fonts";
import { exportScene } from "../scene/export";
import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { Keyboard, Pointer, UI } from "./helpers/ui";
import {
  act,
  fireEvent,
  GlobalTestState,
  render,
  screen,
  unmountComponent,
  waitFor,
} from "./test-utils";

import type { NormalizedZoomValue } from "../types";

const { h } = window;
const mouse = new Pointer("mouse");

const CELL_EDITOR_SELECTOR = ".excalidraw-table-cell-wysiwyg";

const getTables = () =>
  h.elements.filter(
    (element) => element.type === "table" && !element.isDeleted,
  ) as ExcalidrawTableElement[];

const getTable = () => {
  const [table] = getTables();
  expect(table).toBeDefined();
  return table;
};

const getEditor = () =>
  document.querySelector<HTMLTextAreaElement>(CELL_EDITOR_SELECTOR);

const createTable = (opts: { cells?: string[][] } = {}) => {
  const table = API.createElement({
    type: "table",
    x: 100,
    y: 100,
    rows: 2,
    columns: 2,
    ...opts,
  });
  API.updateScene({
    elements: [table],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  API.setSelectedElements([table]);
  return table;
};

const sendPasteEvent = (text: string) => {
  document.dispatchEvent(createPasteEvent({ types: { "text/plain": text } }));
};

const paste = (text: string) => {
  Keyboard.withModifierKeys({ ctrl: true }, () => {
    Keyboard.keyPress(KEYS.V);
    sendPasteEvent(text);
  });
};

/** scene point of a control geometry point (table-local, unrotated) */
const toScene = (table: ExcalidrawTableElement, [x, y]: [number, number]) =>
  getTableScenePoint(table, [x, y]);

beforeEach(async () => {
  unmountComponent();
  localStorage.clear();
  mouse.reset();

  await render(
    <Excalidraw
      autoFocus={true}
      handleKeyboardGlobally={true}
      initialData={{ appState: { zoom: { value: 1 as NormalizedZoomValue } } }}
    />,
  );
  Object.assign(document, {
    elementFromPoint: () => GlobalTestState.canvas,
  });
});

describe("table tool", () => {
  it("creates a default grid and opens the first cell for editing", async () => {
    UI.clickTool("table");
    mouse.click(200, 200);

    const table = getTable();
    expect(table.cells).toHaveLength(DEFAULT_TABLE_ROWS);
    expect(table.cells[0]).toHaveLength(DEFAULT_TABLE_COLUMNS);
    expect(table.width).toBe(
      DEFAULT_TABLE_COLUMNS * DEFAULT_TABLE_COLUMN_WIDTH,
    );
    expect(table.height).toBe(DEFAULT_TABLE_ROWS * DEFAULT_TABLE_ROW_HEIGHT);
    expect(h.state.selectedElementIds).toEqual({ [table.id]: true });
    expect(h.state.activeTool.type).toBe("selection");

    await waitFor(() => expect(getEditor()).not.toBeNull());
    expect(h.state.activeTableCell).toMatchObject({
      elementId: table.id,
      row: 0,
      col: 0,
      editing: true,
    });
  });

  it("shows up in the main toolbar", () => {
    expect(GlobalTestState.renderResult.getByToolName("table")).toBeDefined();
  });
});

describe("cell editing", () => {
  it("types into cells, moves with Tab and commits with Escape", async () => {
    UI.clickTool("table");
    mouse.click(200, 200);
    const editor = await waitFor(() => {
      const el = getEditor();
      expect(el).not.toBeNull();
      return el!;
    });

    fireEvent.input(editor, { target: { value: "first" } });
    expect(getTable().cells[0][0]).toBe("first");

    fireEvent.keyDown(editor, { key: KEYS.TAB });
    await waitFor(() =>
      expect(h.state.activeTableCell).toMatchObject({ row: 0, col: 1 }),
    );
    const second = getEditor()!;
    fireEvent.input(second, { target: { value: "second" } });

    fireEvent.keyDown(second, { key: KEYS.ESCAPE });
    await waitFor(() => expect(getEditor()).toBeNull());
    expect(getTable().cells[0].slice(0, 2)).toEqual(["first", "second"]);
    expect(h.state.activeTableCell?.editing).toBe(false);
  });

  it("grows the row when the text wraps", async () => {
    const table = createTable();
    act(() => {
      h.app.table.startCellEditing(table, 0, 0);
    });
    const editor = await waitFor(() => {
      const el = getEditor();
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.input(editor, {
      target: { value: "word ".repeat(60).trim() },
    });
    expect(getTable().rowHeights[0]).toBeGreaterThan(DEFAULT_TABLE_ROW_HEIGHT);
    expect(getTable().height).toBeGreaterThan(2 * DEFAULT_TABLE_ROW_HEIGHT);
  });

  it("resolves {{variables}} for display only", () => {
    const table = createTable({ cells: [["{{missing}}", ""]] });
    expect(getTable().cells[0][0]).toBe("{{missing}}");
    expect(table.cells[0][0]).toBe("{{missing}}");
  });
});

describe("row and column controls", () => {
  it("inserts a row from an insert dot", () => {
    const table = createTable();
    const geometry = getTableControlGeometry(table, h.state.zoom);
    const [x, y] = toScene(table, geometry.rowInserts[1]);
    mouse.click(x, y);
    expect(getTable().cells).toHaveLength(3);
    expect(h.state.activeTableCell).toMatchObject({ row: 1, span: "row" });
  });

  it("inserts consecutive rows from the insert dots", () => {
    const table = createTable();
    for (let index = 1; index <= 2; index++) {
      const current = getTable();
      const geometry = getTableControlGeometry(current, h.state.zoom);
      const [x, y] = toScene(current, geometry.rowInserts[index]);
      mouse.reset();
      mouse.click(x, y);
    }
    expect(getTable().cells).toHaveLength(table.cells.length + 2);
  });

  it("inserts a column from an insert dot", () => {
    const table = createTable();
    const geometry = getTableControlGeometry(table, h.state.zoom);
    const [x, y] = toScene(table, geometry.colInserts[2]);
    mouse.click(x, y);
    expect(getTable().cells[0]).toHaveLength(3);
    expect(h.state.activeTableCell).toMatchObject({ col: 2, span: "col" });
  });

  it("selects a line from its grip and shows the floating bar", () => {
    const table = createTable();
    const geometry = getTableControlGeometry(table, h.state.zoom);
    const grip = geometry.colGrips[1];
    const [gx, gy] = toScene(table, [
      grip.x + grip.width / 2,
      grip.y + grip.height / 2,
    ]);
    mouse.click(gx, gy);

    expect(h.state.activeTableCell).toMatchObject({ col: 1, span: "col" });
    const bar = screen.getByTestId("table-line-actions");
    expect(bar).toBeDefined();
    expect(screen.getByTestId("tableInsertColumnRight")).toBeDefined();

    fireEvent.click(screen.getByTestId("tableDeleteColumn"));
    expect(getTable().cells[0]).toHaveLength(1);
  });

  it("deletes a row from the action, and undo restores it", () => {
    const table = createTable({
      cells: [
        ["a", "b"],
        ["c", "d"],
      ],
    });
    act(() => {
      h.app.table.setActiveCell(table, 0, 0, "row");
    });
    API.executeAction(actionTableDeleteRow);
    expect(getTable().cells).toEqual([["c", "d"]]);

    Keyboard.undo();
    expect(getTable().cells).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    Keyboard.redo();
    expect(getTable().cells).toEqual([["c", "d"]]);
  });

  it("keeps the last row and column", () => {
    const table = createTable({ cells: [["a"]] });
    act(() => {
      h.app.table.setActiveCell(table, 0, 0, "row");
    });
    API.executeAction(actionTableDeleteRow);
    expect(getTable().cells).toEqual([["a"]]);
    act(() => {
      h.app.table.setActiveCell(table, 0, 0, "col");
    });
    API.executeAction(actionTableDeleteColumn);
    expect(getTable().cells).toEqual([["a"]]);
  });

  it("inserts via actions with an explicit index", () => {
    const table = createTable();
    act(() => {
      h.app.actionManager.executeAction(actionTableInsertRowBelow, "api", {
        elementId: table.id,
        index: 0,
      });
    });
    expect(getTable().cells).toHaveLength(3);
    act(() => {
      h.app.actionManager.executeAction(actionTableInsertColumnRight, "api", {
        elementId: table.id,
        index: 2,
      });
    });
    expect(getTable().cells[0]).toHaveLength(3);
  });

  it("resizes a column by dragging its divider", () => {
    const table = createTable();
    const dividerX = table.x + DEFAULT_TABLE_COLUMN_WIDTH;
    mouse.downAt(dividerX, table.y + 20);
    mouse.moveTo(dividerX + 50, table.y + 20);
    mouse.upAt(dividerX + 50, table.y + 20);
    expect(getTable().columnWidths[0]).toBeCloseTo(
      DEFAULT_TABLE_COLUMN_WIDTH + 50,
    );
    expect(getTable().x).toBe(table.x);
  });
});

describe("header row", () => {
  it("toggles through the action and undo", () => {
    createTable();
    expect(getTable().headerRow).toBe(false);
    API.executeAction(actionToggleTableHeaderRow);
    expect(getTable().headerRow).toBe(true);
    Keyboard.undo();
    expect(getTable().headerRow).toBe(false);
  });
});

describe("context menu", () => {
  it("offers the row and column entries for the clicked cell", () => {
    const table = createTable();
    fireEvent.contextMenu(GlobalTestState.interactiveCanvas, {
      button: 2,
      clientX: table.x + 10,
      clientY: table.y + 10,
    });
    const menu = UI.queryContextMenu();
    expect(menu).not.toBeNull();
    expect(
      menu!.querySelector('li[data-testid="tableInsertRowBelow"]'),
    ).not.toBeNull();
    expect(
      menu!.querySelector('li[data-testid="tableDeleteColumn"]'),
    ).not.toBeNull();
    expect(
      menu!.querySelector('li[data-testid="toggleTableHeaderRow"]'),
    ).not.toBeNull();
  });
});

describe("clipboard", () => {
  it("pastes tab-separated text as a table", async () => {
    paste("name\trole\nAda\tdev\nLin\tops");
    await waitFor(() => expect(getTables()).toHaveLength(1));
    expect(getTable().cells).toEqual([
      ["name", "role"],
      ["Ada", "dev"],
      ["Lin", "ops"],
    ]);
  });

  it("keeps comma-separated prose as text", async () => {
    paste("hello, world, this is prose");
    await waitFor(() =>
      expect(h.elements.some((element) => element.type === "text")).toBe(true),
    );
    expect(getTables()).toHaveLength(0);
  });

  it("offers the Table tile for numeric data and inserts it", async () => {
    paste("Week\tUsers\nWeek 1\t814\nWeek 2\t1030");
    const tile = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(
        '.ChartPreview[aria-label="Table"]',
      );
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.click(tile);
    await waitFor(() => expect(getTables()).toHaveLength(1));
    expect(getTable().cells[2]).toEqual(["Week 2", "1030"]);
  });

  it("copies the selected table as TSV", async () => {
    let copied: string | null = null;
    document.execCommand = vi.fn(() => true);
    vi.spyOn(HTMLTextAreaElement.prototype, "select").mockImplementation(
      function (this: HTMLTextAreaElement) {
        copied = this.value;
      },
    );
    createTable({
      cells: [
        ["a", "b"],
        ["c", "d"],
      ],
    });
    await act(async () => {
      h.app.actionManager.executeAction(copyText);
    });
    await waitFor(() => expect(copied).toBe("a\tb\nc\td"));
  });
});

describe("fonts", () => {
  it("collects the characters of raw and resolved cell text", () => {
    const table = API.createElement({
      type: "table",
      cells: [["ab{{n}}", "zz"]],
    });
    const charsPerFamily = (Fonts as any).getCharsPerFamily(
      [table],
      new Map([["n", "XY"]]),
    ) as Record<number, Set<string>>;
    const chars = charsPerFamily[table.fontFamily];
    for (const char of "ab{n}zzXY") {
      expect(chars.has(char)).toBe(true);
    }
  });
});

describe("export", () => {
  const createExportTable = () =>
    API.createElement({
      type: "table",
      id: "table-export",
      x: 10,
      y: 20,
      index: "a0" as FractionalIndex,
      cells: [
        ["Name", "Value"],
        ["{{name}}", "x"],
      ],
      headerRow: true,
    });

  it("exports an SVG with resolved variables", async () => {
    const svg = await exportScene({
      type: "svg",
      data: { elements: [createExportTable()], files: {} },
      config: {
        canvasBackgroundColor: false,
        skipInliningFonts: true,
        variables: new Map([["name", "Excalidraw"]]),
      },
    });

    expect(
      [...svg.querySelectorAll("text")].map((text) => text.textContent),
    ).toEqual(["Name", "Value", "Excalidraw", "x"]);
    expect(svg.outerHTML).toMatchSnapshot();
  });

  it("leaves unknown placeholders as written", async () => {
    const svg = await exportScene({
      type: "svg",
      data: { elements: [createExportTable()], files: {} },
      config: { canvasBackgroundColor: false, skipInliningFonts: true },
    });
    expect(
      [...svg.querySelectorAll("text")].map((text) => text.textContent),
    ).toContain("{{name}}");
  });
});
