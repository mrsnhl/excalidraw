import clsx from "clsx";
import { useEffect, useRef } from "react";

import { KEYS } from "@excalidraw/common";

import { atom, editorJotaiStore, useAtomValue } from "../editor-jotai";
import { t } from "../i18n";

import { variablesIcon } from "./icons";

import "./VariableAutocomplete.scss";

export type VariableAutocompleteItem = { name: string; value: string };

/** where the caret is, in viewport coordinates */
export type CaretAnchor = { left: number; top: number; bottom: number };

export type VariableAutocompleteState = {
  /** the text field the list is for */
  target: HTMLTextAreaElement;
  /** what's typed after `{{` */
  query: string;
  anchor: CaretAnchor;
  items: readonly VariableAutocompleteItem[];
  selectedIndex: number;
  insert: (item: VariableAutocompleteItem) => void;
} | null;

export const variableAutocompleteAtom = atom<VariableAutocompleteState>(null);

const MAX_ITEMS = 8;

/** `{{`, optionally followed by a name being typed, right before the caret */
const OPEN_PLACEHOLDER_REGEX = /\{\{\s*([\p{L}\p{N}_-]*)$/u;
/** the rest of a placeholder that's already closed, right after the caret */
const CLOSING_BRACES_REGEX = /^[\p{L}\p{N}_-]*\s*\}\}/u;

/**
 * The `{{` the caret is in, if any: the range to replace by an inserted
 * placeholder, and what's typed so far.
 */
export const findOpenPlaceholder = (
  textarea: Pick<
    HTMLTextAreaElement,
    "value" | "selectionStart" | "selectionEnd"
  >,
) => {
  const { value, selectionStart, selectionEnd } = textarea;
  if (selectionStart !== selectionEnd) {
    return null;
  }
  const match = value.slice(0, selectionStart).match(OPEN_PLACEHOLDER_REGEX);
  if (!match) {
    return null;
  }
  const closing = value.slice(selectionEnd).match(CLOSING_BRACES_REGEX);
  return {
    query: match[1],
    from: selectionStart - match[0].length,
    // a placeholder that's already closed is replaced as a whole
    to: selectionEnd + (closing ? closing[0].length : 0),
  };
};

/** the variables matching what's typed: prefix matches first, then the rest */
export const filterVariables = (
  variables: readonly VariableAutocompleteItem[],
  query: string,
) => {
  const needle = query.toLowerCase();
  const prefixed: VariableAutocompleteItem[] = [];
  const contained: VariableAutocompleteItem[] = [];
  for (const variable of variables) {
    const name = variable.name.toLowerCase();
    if (name.startsWith(needle)) {
      prefixed.push(variable);
    } else if (name.includes(needle)) {
      contained.push(variable);
    }
  }
  return prefixed.concat(contained).slice(0, MAX_ITEMS);
};

/**
 * Where the caret is on screen, for any text field (also the ones that are
 * scaled, as the on-canvas editor: rotation is not accounted for, so the
 * result is only approximate for a rotated one).
 */
export const getTextareaCaretAnchor = (
  textarea: HTMLTextAreaElement,
  caretOffset = textarea.selectionEnd,
): CaretAnchor => {
  const ownerDocument = textarea.ownerDocument;
  const ownerWindow = ownerDocument.defaultView ?? window;
  const rect = textarea.getBoundingClientRect();
  const fallback = { left: rect.left, top: rect.top, bottom: rect.bottom };

  if (!ownerDocument.body) {
    return fallback;
  }

  const style = ownerWindow.getComputedStyle(textarea);
  const mirror = ownerDocument.createElement("div");
  const marker = ownerDocument.createElement("span");

  // (before the text is put in: the width is the one of the box)
  Object.assign(mirror.style, {
    position: "fixed",
    top: "0",
    left: "0",
    visibility: "hidden",
    pointerEvents: "none",
    overflow: "hidden",
    boxSizing: "border-box",
    width: `${textarea.offsetWidth}px`,
    font: style.font,
    letterSpacing: style.letterSpacing,
    lineHeight: style.lineHeight,
    padding: style.padding,
    border: style.border,
    textAlign: style.textAlign,
    textIndent: style.textIndent,
    tabSize: style.tabSize,
    whiteSpace: style.whiteSpace === "pre" ? "pre" : "pre-wrap",
    overflowWrap: "break-word",
  });
  mirror.dir = textarea.dir;
  mirror.append(
    ownerDocument.createTextNode(textarea.value.slice(0, caretOffset)),
  );
  marker.textContent = "​";
  mirror.append(marker);
  ownerDocument.body.append(mirror);

  try {
    const mirrorRect = mirror.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    const lineHeight =
      markerRect.height || parseFloat(style.lineHeight) || markerRect.bottom;
    // (a scaled editor has a smaller or larger box than it lays out)
    const scale = textarea.offsetWidth ? rect.width / textarea.offsetWidth : 1;
    const left = rect.left + (markerRect.left - mirrorRect.left) * scale;
    const top =
      rect.top + (markerRect.top - mirrorRect.top - textarea.scrollTop) * scale;

    if (!Number.isFinite(left) || !Number.isFinite(top)) {
      return fallback;
    }
    return { left, top, bottom: top + lineHeight * scale };
  } finally {
    mirror.remove();
  }
};

const closeAutocomplete = (textarea?: HTMLTextAreaElement) => {
  const current = editorJotaiStore.get(variableAutocompleteAtom);
  if (current && (!textarea || current.target === textarea)) {
    editorJotaiStore.set(variableAutocompleteAtom, null);
  }
};

/**
 * Makes the given text field suggest the variables as `{{` is typed in:
 * ArrowUp/ArrowDown to move, Enter/Tab to insert, Escape to close the list
 * (and only that). The list itself is the `<VariableAutocomplete />`, which
 * the editor renders.
 *
 * Meant for any text field the placeholders can be typed into (the on-canvas
 * text editor, a table cell editor…). Returns the function that detaches it.
 */
export const attachVariableAutocomplete = (
  textarea: HTMLTextAreaElement,
  opts: {
    /** the variables to suggest from (the winning ones, if duplicated) */
    getVariables: () => readonly VariableAutocompleteItem[];
  },
) => {
  const getState = () => {
    const current = editorJotaiStore.get(variableAutocompleteAtom);
    return current?.target === textarea ? current : null;
  };

  // where the placeholder is that the list has been dismissed for
  let dismissedFrom: number | null = null;

  const update = () => {
    const open = findOpenPlaceholder(textarea);
    if (!open) {
      dismissedFrom = null;
    }
    const items =
      open && open.from !== dismissedFrom
        ? filterVariables(opts.getVariables(), open.query)
        : [];
    if (!open || !items.length) {
      closeAutocomplete(textarea);
      return;
    }
    const previous = getState();
    editorJotaiStore.set(variableAutocompleteAtom, {
      target: textarea,
      query: open.query,
      anchor: getTextareaCaretAnchor(textarea),
      items,
      // keep the choice while the same suggestions are narrowed down
      selectedIndex:
        previous && previous.query === open.query ? previous.selectedIndex : 0,
      insert,
    });
  };

  function insert(item: VariableAutocompleteItem) {
    const open = findOpenPlaceholder(textarea);
    if (!open) {
      return;
    }
    const text = `{{${item.name}}}`;
    const { ownerDocument } = textarea;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(open.from, open.to);
    // goes through the undo stack of the text field, and fires `input`
    if (
      typeof ownerDocument.execCommand !== "function" ||
      !ownerDocument.execCommand("insertText", false, text)
    ) {
      textarea.setRangeText(text, open.from, open.to, "end");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
    closeAutocomplete(textarea);
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const state = getState();
    if (!state || event.isComposing) {
      return;
    }
    const swallow = () => {
      event.preventDefault();
      // (the editor's own key handling must not see it)
      event.stopImmediatePropagation();
    };
    const count = state.items.length;

    if (event.key === KEYS.ARROW_DOWN || event.key === KEYS.ARROW_UP) {
      swallow();
      const step = event.key === KEYS.ARROW_DOWN ? 1 : -1;
      editorJotaiStore.set(variableAutocompleteAtom, {
        ...state,
        selectedIndex: (state.selectedIndex + step + count) % count,
      });
    } else if (
      (event.key === KEYS.ENTER || event.key === KEYS.TAB) &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      swallow();
      insert(state.items[state.selectedIndex]);
    } else if (event.key === KEYS.ESCAPE) {
      swallow();
      dismissedFrom = findOpenPlaceholder(textarea)?.from ?? null;
      closeAutocomplete(textarea);
    }
  };

  const onBlur = () => closeAutocomplete(textarea);

  // (capturing, so that it comes before the field's own key handling)
  textarea.addEventListener("keydown", onKeyDown, true);
  textarea.addEventListener("input", update);
  textarea.addEventListener("click", update);
  textarea.addEventListener("keyup", update);
  textarea.addEventListener("blur", onBlur);

  return () => {
    textarea.removeEventListener("keydown", onKeyDown, true);
    textarea.removeEventListener("input", update);
    textarea.removeEventListener("click", update);
    textarea.removeEventListener("keyup", update);
    textarea.removeEventListener("blur", onBlur);
    closeAutocomplete(textarea);
  };
};

const HighlightedName = ({ name, query }: { name: string; query: string }) =>
  name.toLowerCase().startsWith(query.toLowerCase()) ? (
    <>
      <strong>{name.slice(0, query.length)}</strong>
      {name.slice(query.length)}
    </>
  ) : (
    <>{name}</>
  );

/** the list of suggestions (rendered once, by the editor's UI) */
export const VariableAutocomplete = () => {
  const state = useAtomValue(variableAutocompleteAtom);
  const listRef = useRef<HTMLDivElement>(null);

  // the list is placed under the caret, or above it where there's no room
  useEffect(() => {
    const list = listRef.current;
    if (!state || !list) {
      return;
    }
    const { innerHeight, innerWidth } =
      list.ownerDocument.defaultView ?? window;
    const { width, height } = list.getBoundingClientRect();
    const { anchor } = state;
    const fitsBelow = anchor.bottom + 4 + height <= innerHeight;
    list.style.top = `${
      fitsBelow ? anchor.bottom + 4 : Math.max(0, anchor.top - 4 - height)
    }px`;
    list.style.left = `${Math.max(
      0,
      Math.min(anchor.left, innerWidth - width - 8),
    )}px`;
  }, [state]);

  if (!state) {
    return null;
  }

  return (
    <div
      ref={listRef}
      className="VariableAutocomplete"
      role="listbox"
      aria-label={t("variables.title")}
      data-testid="variable-autocomplete"
      // keeps the focus (and the selection) in the text field
      onMouseDown={(event) => event.preventDefault()}
      style={{ top: state.anchor.bottom + 4, left: state.anchor.left }}
    >
      {state.items.map((item, index) => (
        <div
          key={item.name}
          role="option"
          aria-selected={index === state.selectedIndex}
          className={clsx("VariableAutocomplete__item", {
            "VariableAutocomplete__item--selected":
              index === state.selectedIndex,
          })}
          data-testid={`variable-autocomplete-item-${item.name}`}
          onMouseEnter={() =>
            editorJotaiStore.set(variableAutocompleteAtom, {
              ...state,
              selectedIndex: index,
            })
          }
          onClick={() => state.insert(item)}
        >
          {variablesIcon}
          <span className="VariableAutocomplete__name">
            <HighlightedName name={item.name} query={state.query} />
          </span>
          <span className="VariableAutocomplete__value">{item.value}</span>
        </div>
      ))}
      <div className="VariableAutocomplete__footer">
        <kbd>↑</kbd> <kbd>↓</kbd> {t("variables.autocompleteNavigate")} ·{" "}
        <kbd>Enter</kbd> {t("variables.autocompleteInsert")} · <kbd>Esc</kbd>{" "}
        {t("variables.autocompleteClose")}
      </div>
    </div>
  );
};
