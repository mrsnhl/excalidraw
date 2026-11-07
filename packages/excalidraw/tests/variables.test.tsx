import React from "react";

import {
  CaptureUpdateAction,
  isVariableElement,
  newTextElement,
} from "@excalidraw/element";

import type {
  ExcalidrawElement,
  ExcalidrawTableElement,
  ExcalidrawTextElement,
  NonDeleted,
} from "@excalidraw/element/types";

import {
  actionCreateVariable,
  actionDeleteVariable,
  actionRenameVariable,
  actionSelectAll,
  actionToggleVariablesMenu,
  actionUpdateVariable,
} from "../actions";
import { Excalidraw } from "../index";
import { getUnknownVariableHighlights } from "../renderer/unknownVariables";

import { API } from "./helpers/api";
import { Keyboard, Pointer, UI } from "./helpers/ui";
import { getTextEditor, updateTextEditor } from "./queries/dom";
import {
  act,
  fireEvent,
  render,
  screen,
  unmountComponent,
  waitFor,
  within,
} from "./test-utils";

const { h } = window;
const mouse = new Pointer("mouse");

unmountComponent();

const getVariable = (name: string) =>
  h.app.scene.getVariableElements().find((element) => element.name === name);

const getText = (element: ExcalidrawElement) =>
  API.getElement(
    element as ExcalidrawTextElement,
  ) as NonDeleted<ExcalidrawTextElement>;

const getTable = (element: ExcalidrawElement) =>
  API.getElement(
    element as ExcalidrawTableElement,
  ) as NonDeleted<ExcalidrawTableElement>;

const createVariable = (name: string, value: string) =>
  API.createElement({ type: "variable", name, value });

const setScene = (elements: readonly ExcalidrawElement[]) => {
  API.updateScene({
    elements,
    captureUpdate: CaptureUpdateAction.NEVER,
  });
};

const run = <T,>(
  action: Parameters<typeof h.app.actionManager.executeAction>[0],
  data?: T,
) => {
  act(() => {
    h.app.actionManager.executeAction(action, "api", data);
  });
};

describe("scene variables", () => {
  beforeEach(async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
  });

  describe("resolving", () => {
    it("displays the resolved text and keeps the raw one", () => {
      const text = API.createElement({
        type: "text",
        text: "{{price}} each",
        x: 10,
        y: 10,
      });
      setScene([createVariable("price", "$12"), text]);

      const resolved = getText(text);
      expect(resolved.text).toBe("$12 each");
      expect(resolved.originalText).toBe("{{price}} each");
      expect(resolved.width).toBe(
        newTextElement({ x: 0, y: 0, text: "$12 each" }).width,
      );
    });

    it("updates the text when the value changes, and wraps a long value", () => {
      const variable = createVariable("price", "$12");
      const text = API.createElement({ type: "text", text: "{{price}} each" });
      setScene([variable, text]);
      const width = getText(text).width;

      run(actionUpdateVariable, { id: variable.id, value: "a".repeat(40) });

      expect(getText(text).text).toBe(`${"a".repeat(40)} each`);
      expect(getText(text).width).toBeGreaterThan(width);
    });

    it("re-wraps a bound label and keeps the container fitting a long value", () => {
      const variable = createVariable("v", "x");
      const container = API.createElement({
        type: "rectangle",
        width: 60,
        height: 30,
      });
      const label = API.createElement({
        type: "text",
        text: "{{v}}",
        containerId: container.id,
      });
      API.updateElement(container, {
        boundElements: [{ type: "text", id: label.id }],
      });
      setScene([variable, container, label]);

      run(actionUpdateVariable, {
        id: variable.id,
        value: "wide wide wide wide wide wide wide",
      });

      expect(getText(label).text.replace(/\s+/g, " ").trim()).toBe(
        "wide wide wide wide wide wide wide",
      );
      expect(getText(label).width).toBeGreaterThan(0);
      expect(API.getElement(container).height).toBeGreaterThanOrEqual(30);
    });

    it("leaves unknown names as they are", () => {
      const text = API.createElement({ type: "text", text: "{{nope}}" });
      setScene([text]);
      expect(getText(text).text).toBe("{{nope}}");
    });
  });

  describe("actions and history", () => {
    it("creates a variable with a unique name", () => {
      run(actionCreateVariable, { name: "a", value: "1" });
      run(actionCreateVariable, { name: "a", value: "2" });
      expect(h.app.scene.getVariableElements().map((v) => v.name)).toEqual([
        "a",
        "a_2",
      ]);
    });

    it("refuses invalid names", () => {
      run(actionCreateVariable, { name: "1bad name", value: "1" });
      expect(h.app.scene.getVariableElements()).toHaveLength(0);
    });

    it("undoes and redoes a value change with the displayed text", () => {
      run(actionCreateVariable, { name: "price", value: "$12" });
      const text = API.createElement({ type: "text", text: "{{price}}" });
      API.updateScene({
        elements: [...h.elements, text],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      expect(getText(text).text).toBe("$12");

      run(actionUpdateVariable, {
        id: getVariable("price")!.id,
        value: "$99",
      });
      expect(getText(text).text).toBe("$99");

      Keyboard.undo();
      expect(getVariable("price")!.value).toBe("$12");
      expect(getText(text).text).toBe("$12");

      Keyboard.redo();
      expect(getVariable("price")!.value).toBe("$99");
      expect(getText(text).text).toBe("$99");
    });

    it("does not add history entries when re-deriving the text", () => {
      run(actionCreateVariable, { name: "price", value: "$12" });
      const text = API.createElement({ type: "text", text: "{{price}}" });
      API.updateScene({
        elements: [...h.elements, text],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      run(actionUpdateVariable, {
        id: getVariable("price")!.id,
        value: "$99",
      });
      const undoDepth = API.getUndoStack().length;

      Keyboard.undo();
      expect(API.getUndoStack().length).toBe(undoDepth - 1);
      expect(API.getRedoStack().length).toBe(1);
      Keyboard.redo();
      expect(API.getUndoStack().length).toBe(undoDepth);
      expect(API.getRedoStack().length).toBe(0);
    });

    it("re-resolves after a remote update without a history entry", () => {
      const variable = createVariable("price", "$12");
      const text = API.createElement({ type: "text", text: "{{price}}" });
      setScene([variable, text]);
      const undoDepth = API.getUndoStack().length;

      // (what a collab update does)
      setScene(
        h.elements.map((element) =>
          isVariableElement(element)
            ? { ...element, value: "$7", version: element.version + 1 }
            : element,
        ),
      );

      expect(getText(text).text).toBe("$7");
      expect(API.getUndoStack().length).toBe(undoDepth);
    });

    it("keeps re-resolving after many remote updates", async () => {
      const text = API.createElement({ type: "text", text: "{{price}}" });
      setScene([createVariable("price", "0"), text]);

      for (let value = 1; value <= 6; value++) {
        setScene(
          h.elements.map((element) =>
            isVariableElement(element)
              ? { ...element, value: `${value}`, version: element.version + 1 }
              : element,
          ),
        );
        expect(getText(text).text).toBe(`${value}`);
        // (separate updates, as remote ones are)
        await Promise.resolve();
      }
    });

    it("keeps a host update without a capture undoable", () => {
      run(actionCreateVariable, { name: "price", value: "$12" });
      const undoDepth = API.getUndoStack().length;

      // the host adds a text that is not resolved yet, to be captured later
      const text = API.createElement({ type: "text", text: "{{price}}" });
      API.updateScene({
        elements: [...h.elements, text],
        captureUpdate: CaptureUpdateAction.EVENTUALLY,
      });
      expect(getText(text).text).toBe("$12");

      // the next capture takes the text in, and undo removes it again
      h.app.store.scheduleCapture();
      API.updateScene({ elements: h.elements });
      expect(API.getUndoStack().length).toBe(undoDepth + 1);
      Keyboard.undo();
      expect(
        h.elements.find((element) => element.id === text.id)?.isDeleted,
      ).toBe(true);
    });

    it("renames the variable and rewrites the references in one step", () => {
      run(actionCreateVariable, { name: "price", value: "$12" });
      const text = API.createElement({
        type: "text",
        text: "{{ price }} / {{price}}",
      });
      API.updateScene({
        elements: [...h.elements, text],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });

      run(actionRenameVariable, { id: getVariable("price")!.id, name: "cost" });

      expect(getVariable("cost")?.value).toBe("$12");
      expect(getVariable("price")).toBeUndefined();
      expect(getText(text).originalText).toBe("{{cost}} / {{cost}}");
      expect(getText(text).text).toBe("$12 / $12");

      Keyboard.undo();
      expect(getVariable("price")?.value).toBe("$12");
      expect(getText(text).originalText).toBe("{{ price }} / {{price}}");
      expect(getText(text).text).toBe("$12 / $12");
    });

    it("refuses to rename onto a taken name", () => {
      run(actionCreateVariable, { name: "a", value: "1" });
      run(actionCreateVariable, { name: "b", value: "2" });
      run(actionRenameVariable, { id: getVariable("a")!.id, name: "b" });
      expect(getVariable("a")).toBeDefined();
    });

    it("deletes keeping the placeholder, and undo brings the value back", () => {
      run(actionCreateVariable, { name: "price", value: "$12" });
      const text = API.createElement({ type: "text", text: "{{price}}" });
      API.updateScene({
        elements: [...h.elements, text],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });

      run(actionDeleteVariable, { id: getVariable("price")!.id });
      expect(getVariable("price")).toBeUndefined();
      expect(getText(text).originalText).toBe("{{price}}");
      expect(getText(text).text).toBe("{{price}}");

      Keyboard.undo();
      expect(getVariable("price")?.value).toBe("$12");
      expect(getText(text).text).toBe("$12");
    });

    it("deletes inlining the value", () => {
      run(actionCreateVariable, { name: "price", value: "$12" });
      const text = API.createElement({ type: "text", text: "{{price}}!" });
      API.updateScene({
        elements: [...h.elements, text],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });

      run(actionDeleteVariable, {
        id: getVariable("price")!.id,
        mode: "inline",
      });
      expect(getVariable("price")).toBeUndefined();
      expect(getText(text).originalText).toBe("$12!");
      expect(getText(text).text).toBe("$12!");

      Keyboard.undo();
      expect(getVariable("price")?.value).toBe("$12");
      expect(getText(text).originalText).toBe("{{price}}!");
    });
  });

  describe("scene behavior", () => {
    it("keeps variables out of select-all, hit testing and the visible scene", () => {
      const variable = createVariable("a", "1");
      const text = API.createElement({ type: "text", text: "hi", x: 0, y: 0 });
      setScene([variable, text]);

      run(actionSelectAll);
      expect(Object.keys(h.state.selectedElementIds)).toEqual([text.id]);
      expect(h.app.scene.getNonDeletedElements()).toEqual([text]);

      mouse.clickAt(0, 0);
      expect(h.state.selectedElementIds[variable.id]).toBeUndefined();
    });

    it("includes the variables in getSceneElements()", () => {
      const variable = createVariable("a", "1");
      const text = API.createElement({ type: "text", text: "hi" });
      const deleted = API.createElement({
        type: "variable",
        name: "gone",
        value: "x",
        isDeleted: true,
      });
      setScene([variable, text, deleted]);

      const ids = h.app.getSceneElements().map((element) => element.id);
      expect(ids).toEqual([variable.id, text.id]);
    });

    it("does not select, move or z-order variables with the elements", () => {
      const variable = createVariable("a", "1");
      const rect = API.createElement({ type: "rectangle", x: 0, y: 0 });
      setScene([variable, rect]);
      API.setSelectedElements([rect]);
      Keyboard.withModifierKeys({ ctrl: true, shift: true }, () =>
        Keyboard.keyPress("]"),
      );
      expect(h.elements.map((element) => element.id)).toContain(variable.id);
      expect(h.app.scene.getVariableElements()).toHaveLength(1);
    });
  });

  describe("imperative API", () => {
    it("getVariables() returns the resolved map", () => {
      // (the lower index is the earlier one in the scene)
      setScene([
        API.createElement({
          type: "variable",
          name: "a",
          value: "early",
          index: "a1" as ExcalidrawElement["index"],
        }),
        API.createElement({
          type: "variable",
          name: "a",
          value: "late",
          index: "a5" as ExcalidrawElement["index"],
        }),
        API.createElement({
          type: "variable",
          name: "b",
          value: "2",
          index: "a9" as ExcalidrawElement["index"],
        }),
      ]);
      expect(h.app.variables.get()).toEqual({ a: "early", b: "2" });
    });

    it("setVariables() upserts and deletes in one history entry", () => {
      const text = API.createElement({ type: "text", text: "{{a}} {{b}}" });
      setScene([createVariable("a", "1"), createVariable("c", "3"), text]);
      const undoDepth = API.getUndoStack().length;

      act(() => {
        h.app.variables.set({ a: "10", b: "20", c: null });
      });

      expect(h.app.variables.get()).toEqual({ a: "10", b: "20" });
      expect(getText(text).text).toBe("10 20");
      expect(API.getUndoStack().length).toBe(undoDepth + 1);

      Keyboard.undo();
      expect(h.app.variables.get()).toEqual({ a: "1", c: "3" });
      expect(getText(text).text).toBe("1 {{b}}");
    });

    it("setVariables() honors captureUpdate", () => {
      act(() => {
        h.app.variables.set(
          { a: "1" },
          { captureUpdate: CaptureUpdateAction.NEVER },
        );
      });
      expect(h.app.variables.get()).toEqual({ a: "1" });
      expect(API.getUndoStack()).toHaveLength(0);
    });
  });

  describe("text editing", () => {
    it("shows the raw text in the editor, and resolves it on submit", async () => {
      run(actionCreateVariable, { name: "price", value: "$12" });

      UI.clickTool("text");
      mouse.clickAt(100, 100);
      const editor = await getTextEditor();
      updateTextEditor(editor, "{{price}} each");
      Keyboard.exitTextEditor(editor);

      const text = h.elements.find(
        (element) => element.type === "text",
      ) as ExcalidrawTextElement;
      expect(text.originalText).toBe("{{price}} each");
      expect(text.text).toBe("$12 each");

      // editing again starts from the raw text
      mouse.doubleClickAt(text.x + 2, text.y + 2);
      const editor2 = await getTextEditor();
      expect(editor2.value).toBe("{{price}} each");
    });

    it("suggests the variables after {{ and inserts the picked one", async () => {
      run(actionCreateVariable, { name: "price", value: "$12" });
      run(actionCreateVariable, { name: "name", value: "Ann" });

      UI.clickTool("text");
      mouse.clickAt(100, 100);
      const editor = await getTextEditor();

      editor.focus();
      updateTextEditor(editor, "total {{pr");
      editor.setSelectionRange(10, 10);
      fireEvent.keyUp(editor, { key: "r" });

      const list = await screen.findByTestId("variable-autocomplete");
      expect(list).toBeInTheDocument();
      expect(
        screen.getByTestId("variable-autocomplete-item-price"),
      ).toBeTruthy();
      expect(
        screen.queryByTestId("variable-autocomplete-item-name"),
      ).toBeNull();

      fireEvent.keyDown(editor, { key: "Enter" });
      expect(editor.value).toBe("total {{price}}");
      await waitFor(() =>
        expect(screen.queryByTestId("variable-autocomplete")).toBeNull(),
      );
    });

    it("moves the choice with the arrow keys and closes with Escape", async () => {
      run(actionCreateVariable, { name: "alpha", value: "1" });
      run(actionCreateVariable, { name: "alps", value: "2" });

      UI.clickTool("text");
      mouse.clickAt(100, 100);
      const editor = await getTextEditor();
      editor.focus();
      updateTextEditor(editor, "{{al");
      editor.setSelectionRange(4, 4);
      fireEvent.keyUp(editor, { key: "l" });

      await screen.findByTestId("variable-autocomplete");
      fireEvent.keyDown(editor, { key: "ArrowDown" });
      fireEvent.keyDown(editor, { key: "Enter" });
      expect(editor.value).toBe("{{alps}}");

      updateTextEditor(editor, "{{al");
      editor.setSelectionRange(4, 4);
      fireEvent.keyUp(editor, { key: "l" });
      await screen.findByTestId("variable-autocomplete");
      fireEvent.keyDown(editor, { key: "Escape" });
      await waitFor(() =>
        expect(screen.queryByTestId("variable-autocomplete")).toBeNull(),
      );
      // Escape only closed the list, the editor is still there
      expect(h.state.editingTextElement).not.toBeNull();
      expect(editor.value).toBe("{{al");
    });
  });

  describe("variables panel", () => {
    const openPanel = async () => {
      run(actionToggleVariablesMenu);
      return screen.findByTestId("variables-menu");
    };

    it("adds, edits, renames and deletes", async () => {
      await openPanel();
      expect(screen.getByText(/No variables yet/)).toBeTruthy();

      fireEvent.click(screen.getByTestId("variable-add"));
      const created = h.app.scene.getVariableElements()[0];
      expect(created.name).toBe("variable");

      // rename starts right away
      const nameInput = screen.getByLabelText("Variable name");
      fireEvent.change(nameInput, { target: { value: "price" } });
      fireEvent.keyDown(nameInput, { key: "Enter" });
      expect(getVariable("price")).toBeDefined();

      const valueInput = await screen.findByLabelText("Value: price");
      fireEvent.change(valueInput, { target: { value: "$12" } });
      fireEvent.keyDown(valueInput, { key: "Enter" });
      expect(getVariable("price")!.value).toBe("$12");

      fireEvent.click(screen.getByTestId("variable-menu-price"));
      fireEvent.click(await screen.findByTestId("variable-menu-delete"));
      expect(getVariable("price")).toBeUndefined();
    });

    it("shows the usage counts and the missing names", async () => {
      setScene([
        createVariable("price", "$12"),
        API.createElement({ type: "text", text: "{{price}} {{ghost}}" }),
        API.createElement({ type: "text", text: "{{price}}" }),
      ]);
      await openPanel();

      expect(
        within(screen.getByTestId("variable-row-price")).getByText("2 uses"),
      ).toBeTruthy();
      const missing = await screen.findByTestId("variable-missing-ghost");
      expect(within(missing).getByText("1 use")).toBeTruthy();

      fireEvent.click(within(missing).getByText("Create"));
      expect(getVariable("ghost")).toBeDefined();
      expect(screen.queryByTestId("variable-missing-ghost")).toBeNull();
    });

    it("asks what to do with the placeholders when a used variable is deleted", async () => {
      const text = API.createElement({ type: "text", text: "{{price}}" });
      setScene([createVariable("price", "$12"), text]);
      await openPanel();

      fireEvent.click(screen.getByTestId("variable-menu-price"));
      fireEvent.click(await screen.findByTestId("variable-menu-delete"));
      fireEvent.click(await screen.findByTestId("variable-delete-inline"));
      fireEvent.click(
        within(
          document.querySelector(".confirm-dialog-buttons") as HTMLElement,
        ).getByText("Delete"),
      );

      expect(getVariable("price")).toBeUndefined();
      expect(getText(text).originalText).toBe("$12");
    });

    it("drops the value draft on Escape, and commits it once on Enter", async () => {
      setScene([createVariable("price", "$12")]);
      await openPanel();
      const valueInput =
        screen.getByLabelText<HTMLInputElement>("Value: price");

      valueInput.focus();
      fireEvent.change(valueInput, { target: { value: "$99" } });
      fireEvent.keyDown(valueInput, { key: "Escape" });
      expect(getVariable("price")!.value).toBe("$12");
      expect(valueInput.value).toBe("$12");

      const undoStackSize = h.history.undoStack.length;
      valueInput.focus();
      fireEvent.change(valueInput, { target: { value: "$15" } });
      fireEvent.keyDown(valueInput, { key: "Enter" });
      expect(getVariable("price")!.value).toBe("$15");
      expect(h.history.undoStack.length).toBe(undoStackSize + 1);
    });

    it("flags a duplicated name", async () => {
      setScene([createVariable("a", "1"), createVariable("a", "2")]);
      await openPanel();
      expect(
        (await screen.findAllByLabelText(/Duplicate name/)).length,
      ).toBeGreaterThan(0);
    });
  });

  describe("unknown variable highlight", () => {
    it("finds the unknown name of a selected text", () => {
      const text = API.createElement({
        type: "text",
        text: "hello {{ghost}}",
        x: 100,
        y: 100,
      });
      setScene([text]);
      API.setSelectedElements([text]);

      const highlights = getUnknownVariableHighlights(
        [getText(text)],
        null,
        h.app.scene.getVariables().map,
        h.app.scene.getNonDeletedElementsMap(),
        h.app.renderEnvironment,
      );
      expect(
        highlights.flatMap(({ rects }) => rects.map(({ name }) => name)),
      ).toEqual(["ghost"]);
    });

    it("does not highlight known names, nor texts that aren't selected", () => {
      const text = API.createElement({ type: "text", text: "{{a}} {{b}}" });
      setScene([createVariable("a", "1"), createVariable("b", "2"), text]);
      API.setSelectedElements([text]);
      const args = [
        h.app.scene.getVariables().map,
        h.app.scene.getNonDeletedElementsMap(),
        h.app.renderEnvironment,
      ] as const;
      expect(
        getUnknownVariableHighlights([getText(text)], null, ...args),
      ).toEqual([]);
      expect(getUnknownVariableHighlights([], null, ...args)).toEqual([]);
    });
  });
  describe("tables", () => {
    const createTable = (cells: string[][]) =>
      API.createElement({
        type: "table",
        x: 100,
        y: 100,
        rows: cells.length,
        columns: cells[0].length,
        cells,
      });

    it("grows the row when a value in a cell gets longer", () => {
      const variable = createVariable("v", "x");
      const table = createTable([["{{v}}", "b"]]);
      setScene([variable, table]);
      const { rowHeights, height } = getTable(table);

      run(actionUpdateVariable, {
        id: variable.id,
        value: "long value ".repeat(20).trim(),
      });

      expect(getTable(table).rowHeights[0]).toBeGreaterThan(rowHeights[0]);
      expect(getTable(table).height).toBeGreaterThan(height);
      expect(getTable(table).cells[0][0]).toBe("{{v}}");
    });

    it("rewrites the cells on rename, and inlines them on delete", () => {
      run(actionCreateVariable, { name: "price", value: "$12" });
      const table = createTable([["{{price}}", "{{ price }} each"]]);
      API.updateScene({
        elements: [...h.elements, table],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });

      run(actionRenameVariable, { id: getVariable("price")!.id, name: "cost" });
      expect(getTable(table).cells[0]).toEqual(["{{cost}}", "{{cost}} each"]);

      run(actionDeleteVariable, {
        id: getVariable("cost")!.id,
        mode: "inline",
      });
      expect(getTable(table).cells[0]).toEqual(["$12", "$12 each"]);
    });

    it("counts a table as one use", async () => {
      setScene([
        createVariable("price", "$12"),
        createTable([["{{price}}", "{{price}}"]]),
        API.createElement({ type: "text", text: "{{price}}" }),
      ]);
      run(actionToggleVariablesMenu);
      await screen.findByTestId("variables-menu");

      expect(
        within(screen.getByTestId("variable-row-price")).getByText("2 uses"),
      ).toBeTruthy();
    });

    it("suggests the variables in a cell, and Tab picks instead of moving", async () => {
      run(actionCreateVariable, { name: "price", value: "$12" });
      const table = createTable([["", ""]]);
      API.updateScene({
        elements: [...h.elements, table],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      act(() => {
        h.app.table.startCellEditing(getTable(table), 0, 0);
      });
      const editor = await waitFor(() => {
        const el = document.querySelector<HTMLTextAreaElement>(
          ".excalidraw-table-cell-wysiwyg",
        );
        expect(el).not.toBeNull();
        return el!;
      });

      editor.focus();
      updateTextEditor(editor, "{{pr");
      editor.setSelectionRange(4, 4);
      fireEvent.keyUp(editor, { key: "r" });
      expect(
        await screen.findByTestId("variable-autocomplete-item-price"),
      ).toBeTruthy();

      fireEvent.keyDown(editor, { key: "Tab" });
      expect(editor.value).toBe("{{price}}");
      expect(h.state.activeTableCell).toMatchObject({ row: 0, col: 0 });
      await waitFor(() =>
        expect(screen.queryByTestId("variable-autocomplete")).toBeNull(),
      );
    });

    it("highlights the unknown names of a selected table, but not of the edited cell", () => {
      const table = createTable([["{{ghost}}", "{{known}} {{other}}"]]);
      setScene([createVariable("known", "1"), table]);
      const args = [
        h.app.scene.getVariables().map,
        h.app.scene.getNonDeletedElementsMap(),
        h.app.renderEnvironment,
      ] as const;
      const names = (
        highlights: ReturnType<typeof getUnknownVariableHighlights>,
      ) => highlights.flatMap(({ rects }) => rects.map(({ name }) => name));

      expect(
        names(getUnknownVariableHighlights([getTable(table)], null, ...args)),
      ).toEqual(["ghost", "other"]);
      expect(
        names(
          getUnknownVariableHighlights([getTable(table)], null, ...args, {
            elementId: table.id,
            row: 0,
            col: 0,
          }),
        ),
      ).toEqual(["other"]);
      expect(getUnknownVariableHighlights([], null, ...args)).toEqual([]);
    });
  });
});
