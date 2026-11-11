import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { debounce, findUnknownVariableRanges } from "@excalidraw/common";
import {
  HTML_FRAME_SANDBOX,
  getHtmlFrameContentBox,
  getHtmlFrameDocument,
  isHtmlElement,
} from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { actionUpdateHtmlFrame } from "../actions/actionHtmlFrame";
import { t } from "../i18n";

import { useApp, useExcalidrawActionManager } from "./App";
import { Dialog } from "./Dialog";
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

  const stageRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState<{ width: number; height: number }>(
    { width: 0, height: 0 },
  );
  useLayoutEffect(() => {
    const stage = stageRef.current;
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
  }, [app]);

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
  const scale =
    stageSize.width && stageSize.height
      ? Math.min(1, stageSize.width / box.width, stageSize.height / box.height)
      : 1;

  const apply = () => {
    updatePreview.cancel();
    actionManager.executeAction(actionUpdateHtmlFrame, "ui", {
      elementId: frame.id,
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
            <div ref={stageRef} className="HtmlFrameDialog__stage-inner">
              <iframe
                className="HtmlFrameDialog__preview"
                data-testid="html-frame-preview"
                title={t("htmlFrame.previewTitle")}
                sandbox={HTML_FRAME_SANDBOX}
                referrerPolicy="no-referrer"
                srcDoc={getHtmlFrameDocument({ html: previewHtml }, variables)}
                style={{
                  width: box.width,
                  height: box.height,
                  transform: `scale(${scale})`,
                }}
              />
            </div>
          </div>
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
