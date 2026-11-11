import { useEffect, useLayoutEffect, useMemo, useState } from "react";

import {
  debounce,
  findUnknownVariableRanges,
  resolveVariables,
} from "@excalidraw/common";
import {
  HTML_FRAME_SANDBOX,
  getHtmlFrameContentBox,
  getHtmlSnapshotDataURLForDocument,
  isHtmlElement,
} from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { actionUpdateHtmlFrame } from "../actions/actionHtmlFrame";
import { t } from "../i18n";

import { useApp, useExcalidrawActionManager } from "./App";
import { Dialog } from "./Dialog";
import { FilledButton } from "./FilledButton";
import { playerPlayIcon } from "./icons";
import { TTDDialogInput } from "./TTDDialog/TTDDialogInput";
import { TTDDialogPanel } from "./TTDDialog/TTDDialogPanel";
import { TTDDialogPanels } from "./TTDDialog/TTDDialogPanels";
import { TTDDialogSubmitShortcut } from "./TTDDialog/TTDDialogSubmitShortcut";

import "./TTDDialog/TTDDialog.scss";
import "./HtmlFrameDialog.scss";

/** how long the preview waits after the last keystroke before it reloads */
const PREVIEW_DELAY_MS = 300;

/**
 * Code editor for an HTML frame, with a live preview at the frame's own
 * size (scaled down to fit). Nothing changes on the canvas until "Apply".
 */
export const HtmlFrameDialog = ({
  elementId,
  onClose,
}: {
  elementId: ExcalidrawElement["id"];
  onClose: () => void;
}) => {
  const app = useApp();
  const actionManager = useExcalidrawActionManager();
  const element = app.scene.getElement(elementId);
  const frame = isHtmlElement(element) && !element.isDeleted ? element : null;

  const [html, setHtml] = useState(frame?.html ?? "");
  // the markup the edit started from: a different markup on Apply means
  // someone else changed the frame meanwhile
  const [baseHtml, setBaseHtml] = useState(html);
  const [notice, setNotice] = useState<"locked" | "conflict" | null>(null);
  // markup the user has not run yet (from a file or another person) shows
  // a static snapshot in the preview until the user runs it
  const [previewRuns, setPreviewRuns] = useState(
    () => !!frame && app.isHtmlFrameTrusted(frame),
  );
  const [previewHtml, setPreviewHtml] = useState(html);
  const [updatePreview] = useState(() =>
    debounce((next: string) => setPreviewHtml(next), PREVIEW_DELAY_MS),
  );
  useEffect(() => () => updatePreview.cancel(), [updatePreview]);

  // the frame was deleted (e.g. by a collaborator) while the editor was open
  useEffect(() => {
    if (!frame) {
      onClose();
    }
  }, [frame, onClose]);

  // the stage mounts after this component (the Dialog renders in a portal),
  // so it is state, not a ref object: the measuring effect must re-run then
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState<{ width: number; height: number }>(
    { width: 0, height: 0 },
  );
  useLayoutEffect(() => {
    if (!stage) {
      return;
    }
    const measure = () =>
      setStageSize({ width: stage.clientWidth, height: stage.clientHeight });
    measure();
    const ResizeObserver = app.ownerWindow.ResizeObserver;
    if (!ResizeObserver) {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [app, stage]);

  if (!frame) {
    return null;
  }

  const variables = app.scene.getVariables().map;
  const unknownNames = [
    ...new Set(
      findUnknownVariableRanges(html, variables).map(({ name }) => name),
    ),
  ];

  const box = getHtmlFrameContentBox(frame);
  const previewDocument = resolveVariables(previewHtml, variables);
  const scale =
    stageSize.width && stageSize.height
      ? Math.min(1, stageSize.width / box.width, stageSize.height / box.height)
      : 1;

  // the dialog stays open when Apply cannot write the markup, so the typed
  // markup is not lost
  const apply = () => {
    updatePreview.cancel();
    // read the frame again: a collaborator can change it without a re-render
    const current = app.scene.getElement(elementId);
    if (!isHtmlElement(current) || current.isDeleted) {
      onClose();
      return;
    }
    if (current.locked || app.state.viewModeEnabled) {
      setNotice("locked");
      return;
    }
    if (current.html !== baseHtml && current.html !== html) {
      setBaseHtml(current.html);
      setNotice("conflict");
      return;
    }
    // markup the user applied runs at once, also when it is unchanged
    app.trustHtmlFrame(current.id, html);
    actionManager.executeAction(actionUpdateHtmlFrame, "ui", {
      elementId: current.id,
      html,
    });
    onClose();
  };

  return (
    <Dialog
      className="HtmlFrameDialog"
      size={1200}
      onCloseRequest={onClose}
      title={t("htmlFrame.title")}
      autofocus={false}
    >
      <div className="ttd-dialog-desc">{t("htmlFrame.description")}</div>
      <TTDDialogPanels>
        <TTDDialogPanel>
          <TTDDialogInput
            input={html}
            placeholder={t("htmlFrame.inputPlaceholder")}
            language="plain"
            onChange={(value) => {
              setHtml(value);
              updatePreview(value);
            }}
            onKeyboardSubmit={apply}
          />
        </TTDDialogPanel>
        <TTDDialogPanel
          panelActions={[
            {
              action: onClose,
              label: t("htmlFrame.cancel"),
              variant: "link",
            },
            {
              action: apply,
              label: t("htmlFrame.apply"),
              variant: "button",
            },
          ]}
          panelActionJustifyContent="flex-end"
          renderSubmitShortcut={() => <TTDDialogSubmitShortcut />}
        >
          <div className="ttd-dialog-output-wrapper HtmlFrameDialog__stage">
            <div ref={setStage} className="HtmlFrameDialog__stage-inner">
              {previewRuns ? (
                <iframe
                  className="HtmlFrameDialog__preview"
                  data-testid="html-frame-preview"
                  title={t("htmlFrame.previewTitle")}
                  sandbox={HTML_FRAME_SANDBOX}
                  referrerPolicy="no-referrer"
                  srcDoc={previewDocument}
                  style={{
                    width: box.width,
                    height: box.height,
                    transform: `scale(${scale})`,
                  }}
                />
              ) : (
                <PausedPreview
                  document={previewDocument}
                  width={box.width}
                  height={box.height}
                  scale={scale}
                  onRun={() => {
                    setPreviewRuns(true);
                    // the Run button unmounts, which would drop the focus
                    // to <body>, and Escape / Ctrl+Enter would stop working
                    stage
                      ?.closest<HTMLElement>(".HtmlFrameDialog")
                      ?.querySelector<HTMLElement>(".cm-content, textarea")
                      ?.focus();
                  }}
                />
              )}
            </div>
          </div>
          {notice && (
            <div className="HtmlFrameDialog__notice" role="alert">
              {t(
                notice === "locked" ? "htmlFrame.locked" : "htmlFrame.conflict",
              )}
            </div>
          )}
          {unknownNames.length > 0 && (
            <div className="HtmlFrameDialog__unknown" role="status">
              {t("htmlFrame.unknownVariables", {
                names: unknownNames.map((name) => `{{${name}}}`).join(", "),
              })}
            </div>
          )}
        </TTDDialogPanel>
      </TTDDialogPanels>
    </Dialog>
  );
};

/** the preview of markup the user has not run: a snapshot and a Run button */
const PausedPreview = ({
  document,
  width,
  height,
  scale,
  onRun,
}: {
  document: string;
  width: number;
  height: number;
  scale: number;
  onRun: () => void;
}) => {
  const app = useApp();
  const snapshot = useMemo(
    () =>
      getHtmlSnapshotDataURLForDocument(
        document,
        width,
        height,
        app.ownerDocument,
      ),
    [document, width, height, app],
  );
  return (
    <>
      <div
        className="HtmlFrameDialog__preview HtmlFrameDialog__preview--paused"
        data-testid="html-frame-preview-paused"
        style={{ width, height, transform: `scale(${scale})` }}
      >
        {snapshot && <img src={snapshot} alt="" draggable={false} />}
      </div>
      <div className="HtmlFrameDialog__run">
        <span>{t("htmlFrame.runHint")}</span>
        <FilledButton
          size="medium"
          icon={playerPlayIcon}
          label={t("htmlFrame.run")}
          onClick={onRun}
        />
      </div>
    </>
  );
};
