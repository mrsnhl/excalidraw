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

/** elements that run code, load resources or change how the document loads */
const SNAPSHOT_REMOVED_ELEMENTS =
  "script, noscript, iframe, frame, frameset, object, embed, base, link, meta";

/** an XML name part without a prefix */
const XML_NAME = /^[A-Za-z_][\w.-]*$/;

/**
 * Whether the serialized attribute stays well-formed XML. HTML accepts names
 * such as `@click`, `:class` or `x-on:click`, and a prefix needs a namespace
 * the parser assigned (e.g. `xlink:href` inside an inline `<svg>`).
 */
const isXmlSafeAttribute = (attr: Attr) => {
  const parts = attr.name.split(":");
  if (!parts.every((part) => XML_NAME.test(part)) || parts.length > 2) {
    return false;
  }
  if (attr.namespaceURI) {
    return true;
  }
  // an `xmlns` the parser did not bind would duplicate the declaration that
  // the serializer adds
  return parts.length === 1 ? attr.name !== "xmlns" : parts[0] === "xml";
};

/** attribute values that run code when they are followed */
const SCRIPT_URL = /^(?:javascript|vbscript|data:text\/html)/i;

/**
 * Removes the attributes a snapshot must not keep: event handlers, script
 * URLs, and names that are not valid XML.
 */
const sanitizeSnapshotAttributes = (element: Element) => {
  for (const attr of Array.from(element.attributes)) {
    if (
      !isXmlSafeAttribute(attr) ||
      /^on/i.test(attr.localName) ||
      // eslint-disable-next-line no-control-regex
      SCRIPT_URL.test(attr.value.replace(/[\u0000-\u0020]/g, ""))
    ) {
      element.removeAttributeNode(attr);
    }
  }
};

/**
 * A standalone SVG that draws the document through a `<foreignObject>`, or
 * `null` when the environment has no DOM parser (e.g. a Node export) or the
 * markup cannot become well-formed XML.
 *
 * The markup is parsed into an inert document (nothing runs or loads). Its
 * scripts, nested browsing contexts, event handlers and script URLs are
 * removed, and it is serialized as XHTML, which `<foreignObject>` requires.
 * Browsers render it as an image without running scripts or fetching
 * external resources, so the snapshot shows the static markup and its
 * inline styles.
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
  const parser = new win.DOMParser();
  const parsed = parser.parseFromString(html, "text/html");
  parsed
    .querySelectorAll(SNAPSHOT_REMOVED_ELEMENTS)
    .forEach((node) => node.remove());
  sanitizeSnapshotAttributes(parsed.documentElement);
  parsed.documentElement
    .querySelectorAll("*")
    .forEach((node) => sanitizeSnapshotAttributes(node));
  const xhtml = new win.XMLSerializer().serializeToString(
    parsed.documentElement,
  );
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<foreignObject x="0" y="0" width="${width}" height="${height}">${xhtml}</foreignObject>` +
    `</svg>`;
  // element names can still be invalid XML (e.g. `<my:tag>`): a snapshot
  // that does not parse would show as a broken image
  try {
    const check = parser.parseFromString(svg, "image/svg+xml");
    if (check.getElementsByTagName("parsererror").length) {
      return null;
    }
  } catch {
    return null;
  }
  return svg;
};

/** a snapshot of a document as an SVG data URL, `null` without a DOM */
export const getHtmlSnapshotDataURLForDocument = (
  html: string,
  width: number,
  height: number,
  doc: Document | undefined,
): string | null => {
  const svg = buildHtmlSnapshotSvg(html, width, height, doc);
  return svg
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    : null;
};

/** the snapshot of an HTML frame as an SVG data URL, `null` without a DOM */
export const getHtmlSnapshotDataURL = (
  element: ExcalidrawHtmlElement,
  variables: VariableMap | null | undefined,
  doc: Document | undefined,
): string | null => {
  const box = getHtmlFrameContentBox(element);
  return getHtmlSnapshotDataURLForDocument(
    resolveVariables(element.html, variables),
    box.width,
    box.height,
    doc,
  );
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
