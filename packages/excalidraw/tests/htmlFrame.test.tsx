import React from "react";

import { CaptureUpdateAction } from "@excalidraw/element";
import {
  DEFAULT_HTML_FRAME_HEIGHT,
  DEFAULT_HTML_FRAME_MARKUP,
  DEFAULT_HTML_FRAME_WIDTH,
  HTML_FRAME_SANDBOX,
  buildHtmlSnapshotSvg,
  countVariableUsage,
} from "@excalidraw/element";
import { KEYS } from "@excalidraw/common";

import type {
  ExcalidrawElement,
  ExcalidrawHtmlElement,
  FractionalIndex,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

import {
  actionEditHtmlFrame,
  actionUpdateHtmlFrame,
} from "../actions/actionHtmlFrame";
import {
  actionDeleteVariable,
  actionRenameVariable,
} from "../actions/actionVariables";
import { getDefaultAppState } from "../appState";
import { restoreElements } from "../data/restore";
import { Excalidraw } from "../index";
import { exportScene } from "../scene/export";

import { API } from "./helpers/api";
import { Keyboard, Pointer, UI } from "./helpers/ui";
import {
  GlobalTestState,
  act,
  mockBoundingClientRect,
  render,
  restoreOriginalGetBoundingClientRect,
  screen,
  unmountComponent,
  waitFor,
} from "./test-utils";

const { h } = window;
const mouse = new Pointer("mouse");

const run = <T,>(
  action: Parameters<typeof h.app.actionManager.executeAction>[0],
  data?: T,
) => {
  let result: unknown;
  act(() => {
    result = h.app.actionManager.executeAction(action, "api", data);
  });
  return result;
};

const getFrames = () =>
  h.elements.filter(
    (element): element is ExcalidrawHtmlElement =>
      element.type === "html" && !element.isDeleted,
  );

const createFrame = (html = "<p>{{price}}</p>", extra: object = {}) => {
  const frame = API.createElement({
    type: "html",
    x: 100,
    y: 100,
    width: 300,
    height: 200,
    html,
    ...extra,
  });
  API.updateScene({
    elements: [...h.elements, frame],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  return frame;
};

const addVariable = (name: string, value: string) => {
  const variable = API.createElement({ type: "variable", name, value });
  API.updateScene({
    elements: [...h.elements, variable],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  return variable;
};

beforeEach(async () => {
  unmountComponent();
  localStorage.clear();
  mouse.reset();
  await render(<Excalidraw handleKeyboardGlobally={true} />);
  Object.assign(document, {
    elementFromPoint: () => GlobalTestState.canvas,
  });
});

describe("HTML tool", () => {
  it("shows up in the main toolbar", () => {
    expect(screen.getByTestId("toolbar-html")).toBeDefined();
  });

  it("places a default frame on click and opens the editor", () => {
    UI.clickTool("html");
    mouse.clickAt(500, 400);

    const [frame] = getFrames();
    expect(frame).toBeDefined();
    expect(frame.width).toBe(DEFAULT_HTML_FRAME_WIDTH);
    expect(frame.height).toBe(DEFAULT_HTML_FRAME_HEIGHT);
    expect(frame.html).toBe(DEFAULT_HTML_FRAME_MARKUP);
    expect(h.state.activeTool.type).toBe("selection");
    expect(h.state.selectedElementIds).toEqual({ [frame.id]: true });
    expect(h.state.openDialog).toEqual({
      name: "htmlEditor",
      elementId: frame.id,
    });
  });

  it("keeps the dragged size", () => {
    UI.clickTool("html");
    mouse.downAt(100, 100);
    mouse.moveTo(400, 300);
    mouse.upAt(400, 300);

    const [frame] = getFrames();
    expect(frame.width).toBe(300);
    expect(frame.height).toBe(200);
  });
});

describe("HTML editor", () => {
  it("opens on double-click and on Enter, but not for a locked frame", () => {
    const frame = createFrame();
    mouse.doubleClickAt(frame.x + 10, frame.y + 10);
    expect(h.state.openDialog).toEqual({
      name: "htmlEditor",
      elementId: frame.id,
    });

    API.setAppState({ openDialog: null });
    API.setSelectedElements([frame]);
    Keyboard.keyPress(KEYS.ENTER);
    expect(h.state.openDialog?.name).toBe("htmlEditor");

    API.setAppState({ openDialog: null });
    API.updateScene({
      elements: h.elements.map((element) =>
        element.id === frame.id ? { ...element, locked: true } : element,
      ),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    mouse.doubleClickAt(frame.x + 10, frame.y + 10);
    expect(h.state.openDialog).toBe(null);
    API.setSelectedElements([frame]);
    run(actionEditHtmlFrame);
    expect(h.state.openDialog).toBe(null);
  });

  it("previews with resolved variables, and lists unknown ones", async () => {
    addVariable("price", "$12");
    const frame = createFrame("<p>{{price}} {{ghost}}</p>");
    API.setSelectedElements([frame]);
    run(actionEditHtmlFrame);

    const preview = await screen.findByTestId("html-frame-preview");
    expect(preview.getAttribute("sandbox")).toBe(HTML_FRAME_SANDBOX);
    expect(preview.getAttribute("srcdoc")).toBe("<p>$12 {{ghost}}</p>");
    expect(screen.getByRole("status").textContent).toContain("{{ghost}}");
  });

  it("applies the markup as one undoable step", () => {
    const frame = createFrame("<p>old</p>");
    run(actionUpdateHtmlFrame, {
      elementId: frame.id,
      html: "<p>new</p>",
    });
    expect(getFrames()[0].html).toBe("<p>new</p>");

    Keyboard.undo();
    expect(getFrames()[0].html).toBe("<p>old</p>");
  });
});

describe("live frame", () => {
  beforeEach(() => {
    mockBoundingClientRect();
  });
  afterEach(() => {
    restoreOriginalGetBoundingClientRect();
  });

  it("renders the resolved markup in a sandboxed iframe", async () => {
    unmountComponent();
    await render(<Excalidraw />);
    await waitFor(() => expect(h.state.width).toBe(200));
    addVariable("price", "$12");
    createFrame("<p>{{price}}</p>", { x: 10, y: 10, width: 100, height: 80 });

    await waitFor(() => {
      const iframe = document.querySelector<HTMLIFrameElement>(
        "iframe.excalidraw__embeddable",
      );
      expect(iframe?.getAttribute("srcdoc")).toBe("<p>$12</p>");
      expect(iframe?.getAttribute("sandbox")).toBe(HTML_FRAME_SANDBOX);
    });
  });
});

describe("variables in HTML frames", () => {
  it("counts the frame as one use", () => {
    createFrame("<p>{{price}} and {{price}}</p>");
    expect(countVariableUsage(h.elements).get("price")).toBe(1);
  });

  it("rewrites the frame when the variable is renamed", () => {
    const variable = addVariable("price", "$12");
    createFrame("<p>{{price}}</p>");
    run(actionRenameVariable, {
      id: variable.id,
      name: "cost",
    });
    expect(getFrames()[0].html).toBe("<p>{{cost}}</p>");
  });

  it("inlines the value when the variable is deleted that way", () => {
    const variable = addVariable("price", "$12");
    createFrame("<p>{{price}}</p>");
    run(actionDeleteVariable, {
      id: variable.id,
      mode: "inline",
    });
    expect(getFrames()[0].html).toBe("<p>$12</p>");
  });
});

describe("restore", () => {
  it("keeps the markup and defaults a missing one", () => {
    const frame = API.createElement({ type: "html", html: "<b>hi</b>" });
    const { html: _html, ...withoutHtml } = frame;
    const [restored, restoredEmpty] = restoreElements(
      [frame, { ...withoutHtml, id: "other" } as ExcalidrawElement],
      null,
    ) as ExcalidrawHtmlElement[];
    expect(restored.html).toBe("<b>hi</b>");
    expect(restoredEmpty.type).toBe("html");
    expect(restoredEmpty.html).toBe("");
  });
});

describe("export", () => {
  const decodeSnapshot = (svg: SVGSVGElement) => {
    const href = svg.querySelector("image")?.getAttribute("href") ?? "";
    expect(href.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    return decodeURIComponent(href.slice(href.indexOf(",") + 1));
  };

  it("embeds a snapshot of the resolved markup in the SVG", async () => {
    const variable = API.createElement({
      type: "variable",
      name: "price",
      value: "$12",
      index: "a0" as FractionalIndex,
    });
    const frame = API.createElement({
      type: "html",
      width: 300,
      height: 200,
      html: "<p>Price: {{price}}</p><script>alert(1)</script>",
      index: "a1" as FractionalIndex,
    });
    const svg = await exportScene({
      type: "svg",
      data: {
        elements: [variable, frame] as NonDeletedExcalidrawElement[],
        appState: getDefaultAppState(),
        files: {},
      },
      config: { skipInliningFonts: true },
    });

    const snapshot = decodeSnapshot(svg);
    expect(snapshot).toContain("<foreignObject");
    expect(snapshot).toContain("Price: $12");
    expect(snapshot).not.toContain("<script");
    // the document's own styles stay inside the nested image
    expect(svg.querySelector("foreignObject")).toBe(null);
  });

  it("serializes the snapshot as XHTML", () => {
    const svg = buildHtmlSnapshotSvg("<p>a<br>b", 100, 50, document);
    expect(svg).toContain('xmlns="http://www.w3.org/1999/xhtml"');
    expect(svg).toContain("<br />");
    expect(() =>
      new DOMParser().parseFromString(svg!, "image/svg+xml"),
    ).not.toThrow();
    expect(
      new DOMParser()
        .parseFromString(svg!, "image/svg+xml")
        .querySelector("parsererror"),
    ).toBe(null);
  });

  it("falls back to the placeholder when there is no DOM parser", () => {
    expect(buildHtmlSnapshotSvg("<p>a</p>", 100, 50, undefined)).toBe(null);
  });
});
