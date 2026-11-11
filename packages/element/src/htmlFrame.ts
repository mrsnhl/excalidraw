import { resolveVariables } from "@excalidraw/common";

import type { VariableMap } from "@excalidraw/common";

import { getRenderEnvironment } from "./renderEnvironment";
import { isHtmlElement } from "./typeChecks";

import type { RenderEnvironment } from "./renderEnvironment";

import type { ExcalidrawElement, ExcalidrawHtmlElement } from "./types";

export const DEFAULT_HTML_FRAME_WIDTH = 480;
export const DEFAULT_HTML_FRAME_HEIGHT = 320;

/** the markup a new HTML frame starts with */
export const DEFAULT_HTML_FRAME_MARKUP = `<style>
  body {
    font-family: system-ui, sans-serif;
    margin: 0;
    padding: 16px;
    color: #1e1e1e;
  }
</style>
<h2>Hello, HTML</h2>
<p>Double-click the frame to edit this markup.</p>
`;

/**
 * Scripts run, but in an opaque origin: no access to the editor, its
 * cookies or its storage. No popups, no top navigation.
 */
export const HTML_FRAME_SANDBOX = "allow-scripts allow-forms";

/** the document the frame shows: the markup with its {{variables}} resolved */
export const getHtmlFrameDocument = (
  element: Pick<ExcalidrawHtmlElement, "html">,
  variables: VariableMap | null | undefined,
): string => resolveVariables(element.html, variables);

/** the area inside the frame border that shows the document */
export const getHtmlFrameContentBox = (
  element: Pick<ExcalidrawHtmlElement, "width" | "height" | "strokeWidth">,
) => {
  const inset = element.strokeWidth;
  return {
    x: inset,
    y: inset,
    width: Math.max(1, element.width - inset * 2),
    height: Math.max(1, element.height - inset * 2),
  };
};

type DomWindow = Window & typeof globalThis;

const getDomWindow = (doc: Document | undefined): DomWindow | null => {
  const win = doc?.defaultView as DomWindow | null | undefined;
  return win && typeof win.DOMParser === "function" && win.XMLSerializer
    ? win
    : null;
};

/**
 * A standalone SVG that draws the document through a `<foreignObject>`, or
 * `null` when the environment has no DOM parser (e.g. a Node export).
 *
 * The markup is parsed into an inert document (nothing runs or loads), its
 * scripts and nested browsing contexts are dropped, and it is serialized as
 * XHTML, which `<foreignObject>` requires. Browsers render it as an image
 * without running scripts or fetching external resources, so the snapshot
 * shows the static markup and its inline styles.
 */
export const buildHtmlSnapshotSvg = (
  html: string,
  width: number,
  height: number,
  doc: Document | undefined,
): string | null => {
  const win = getDomWindow(doc);
  if (!win) {
    return null;
  }
  const parsed = new win.DOMParser().parseFromString(html, "text/html");
  parsed
    .querySelectorAll("script, noscript, iframe, frame, object, embed")
    .forEach((node) => node.remove());
  const xhtml = new win.XMLSerializer().serializeToString(
    parsed.documentElement,
  );
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<foreignObject x="0" y="0" width="${width}" height="${height}">${xhtml}</foreignObject>` +
    `</svg>`
  );
};

const svgToDataURL = (svg: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** the snapshot of an HTML frame as an SVG data URL, `null` without a DOM */
export const getHtmlSnapshotDataURL = (
  element: ExcalidrawHtmlElement,
  variables: VariableMap | null | undefined,
  doc: Document | undefined,
): string | null => {
  const box = getHtmlFrameContentBox(element);
  const svg = buildHtmlSnapshotSvg(
    getHtmlFrameDocument(element, variables),
    box.width,
    box.height,
    doc,
  );
  return svg ? svgToDataURL(svg) : null;
};

const SNAPSHOT_LOAD_TIMEOUT_MS = 3000;

/**
 * Loads the snapshot image. Resolves `null` when it fails, times out, or
 * would taint a canvas (some browsers treat `<foreignObject>` images as
 * cross-origin), so the export then falls back to the placeholder.
 */
const loadSnapshotImage = (
  src: string,
  env: RenderEnvironment,
): Promise<HTMLImageElement | null> =>
  new Promise((resolve) => {
    const image = env.createImage();
    const timeout = setTimeout(() => resolve(null), SNAPSHOT_LOAD_TIMEOUT_MS);
    image.onload = () => {
      clearTimeout(timeout);
      try {
        const probe = env.createCanvas();
        probe.width = 1;
        probe.height = 1;
        const context = probe.getContext("2d");
        context?.drawImage(image, 0, 0);
        context?.getImageData(0, 0, 1, 1);
        resolve(image);
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => {
      clearTimeout(timeout);
      resolve(null);
    };
    image.src = src;
  });

/**
 * Snapshot images of the HTML frames among `elements`, by element id, for a
 * canvas (PNG) export. Frames whose snapshot cannot load are left out.
 */
export const loadHtmlSnapshots = async (
  elements: readonly ExcalidrawElement[],
  variables: VariableMap | null | undefined,
  renderEnvironment?: RenderEnvironment,
): Promise<Map<ExcalidrawElement["id"], HTMLImageElement>> => {
  const snapshots = new Map<ExcalidrawElement["id"], HTMLImageElement>();
  const frames = elements.filter(
    (element): element is ExcalidrawHtmlElement =>
      isHtmlElement(element) && !element.isDeleted,
  );
  if (!frames.length) {
    return snapshots;
  }
  const env = getRenderEnvironment(renderEnvironment);
  const doc =
    env.document ?? (typeof document === "undefined" ? undefined : document);
  await Promise.all(
    frames.map(async (element) => {
      const src = getHtmlSnapshotDataURL(element, variables, doc);
      const image = src ? await loadSnapshotImage(src, env) : null;
      if (image) {
        snapshots.set(element.id, image);
      }
    }),
  );
  return snapshots;
};
