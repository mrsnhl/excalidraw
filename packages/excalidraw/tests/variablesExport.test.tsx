import React from "react";

import type {
  ExcalidrawElement,
  FractionalIndex,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

import { getDefaultAppState } from "../appState";
import { prepareElementsForExport } from "../data";
import { encodePngMetadata } from "../data/image";
import { serializeAsJSON } from "../data/json";
import { restoreElements } from "../data/restore";
import { Excalidraw } from "../index";
import { decodeSvgBase64Payload, exportScene } from "../scene/export";

import { API } from "./helpers/api";
import { render, waitFor } from "./test-utils";

const { h } = window;

// tiny polyfill for TextDecoder.decode on which we depend
Object.defineProperty(window, "TextDecoder", {
  value: class TextDecoder {
    decode(ab: ArrayBuffer) {
      return new Uint8Array(ab).reduce(
        (acc, c) => acc + String.fromCharCode(c),
        "",
      );
    }
  },
});

describe("export with scene variables", () => {
  let variable: NonDeletedExcalidrawElement;
  let deletedVariable: ExcalidrawElement;
  let resolvedText: NonDeletedExcalidrawElement;
  let elements: NonDeletedExcalidrawElement[];

  beforeEach(async () => {
    variable = API.createElement({
      type: "variable",
      id: "V",
      name: "price",
      value: "$12",
      index: "a0" as FractionalIndex,
    });
    deletedVariable = API.createElement({
      type: "variable",
      id: "D",
      name: "gone",
      value: "x",
      index: "a2" as FractionalIndex,
      isDeleted: true,
    });
    resolvedText = {
      ...API.createElement({
        type: "text",
        id: "T",
        text: "$12 each",
        index: "a1" as FractionalIndex,
      }),
      originalText: "{{price}} each",
      width: 60,
      height: 25,
    } as NonDeletedExcalidrawElement;
    elements = [variable, resolvedText];

    await render(<Excalidraw />);
  });

  it("round-trips the variables through the saved JSON", () => {
    const json = JSON.parse(serializeAsJSON(elements, h.state, {}, "local"));
    expect(json.elements).toEqual([
      expect.objectContaining({
        type: "variable",
        name: "price",
        value: "$12",
      }),
      expect.objectContaining({ type: "text", originalText: "{{price}} each" }),
    ]);

    const restored = restoreElements(json.elements, null);
    expect(restored[0]).toEqual(
      expect.objectContaining({
        type: "variable",
        name: "price",
        value: "$12",
      }),
    );
  });

  it("draws the resolved text in the SVG, and embeds the variables", async () => {
    const svg = await exportScene({
      type: "svg",
      data: { elements, appState: getDefaultAppState(), files: {} },
      config: { embedScene: true },
    });
    const svgText = svg.outerHTML;

    expect(svgText).toContain("$12 each");
    expect(svgText).not.toContain("{{price}}");

    // variables are appended after the visual elements
    const decoded = JSON.parse(decodeSvgBase64Payload({ svg: svgText }));
    expect(decoded.elements).toEqual([
      expect.objectContaining({ type: "text", originalText: "{{price}} each" }),
      expect.objectContaining({
        type: "variable",
        name: "price",
        value: "$12",
      }),
    ]);
  });

  it("does not embed deleted variables", async () => {
    const svg = await exportScene({
      type: "svg",
      data: {
        elements: [...elements, deletedVariable as NonDeletedExcalidrawElement],
        appState: getDefaultAppState(),
        files: {},
      },
      config: { embedScene: true },
    });
    const decoded = JSON.parse(decodeSvgBase64Payload({ svg: svg.outerHTML }));
    expect(decoded.elements.map((element: any) => element.id)).toEqual([
      "T",
      "V",
    ]);
  });

  it("does not draw anything for a scene of variables alone", async () => {
    const svg = await exportScene({
      type: "svg",
      data: { elements: [variable], appState: getDefaultAppState(), files: {} },
      config: { embedScene: true },
    });
    expect(svg.outerHTML).not.toContain("price");
    expect(svg.querySelectorAll("g[data-id], text, path").length).toBe(0);
  });

  it("keeps the variables when preparing the elements for export", () => {
    const { exportedElements } = prepareElementsForExport(
      elements,
      h.state,
      false,
    );
    expect(exportedElements.map((element) => element.id).sort()).toEqual([
      "T",
      "V",
    ]);
  });

  it("embeds the variables in a PNG and gets them back", async () => {
    const pngBlob = await API.loadFile("./fixtures/smiley.png");
    const pngBlobEmbedded = await encodePngMetadata({
      blob: pngBlob,
      metadata: serializeAsJSON(elements, h.state, {}, "local"),
    });
    await API.drop([{ kind: "file", file: pngBlobEmbedded }]);

    await waitFor(() => {
      expect(h.app.variables.get()).toEqual({ price: "$12" });
    });
    expect(h.elements.find((element) => element.type === "text")).toEqual(
      expect.objectContaining({ originalText: "{{price}} each" }),
    );
  });
});
