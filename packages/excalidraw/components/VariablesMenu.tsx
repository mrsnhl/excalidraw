import clsx from "clsx";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  KEYS,
  isValidVariableName,
  normalizeVariableName,
} from "@excalidraw/common";

import { countVariableUsage } from "@excalidraw/element";

import type { ExcalidrawVariableElement } from "@excalidraw/element/types";

import {
  actionCreateVariable,
  actionDeleteVariable,
  actionRenameVariable,
  actionUpdateVariable,
} from "../actions";
import { getAvailableVariableName } from "../actions/actionVariables";
import { copyTextToSystemClipboard } from "../clipboard";
import { t } from "../i18n";

import {
  useApp,
  useExcalidrawActionManager,
  useExcalidrawAppState,
} from "./App";
import ConfirmDialog from "./ConfirmDialog";
import { TextField } from "./TextField";
import DropdownMenu from "./dropdownMenu/DropdownMenu";
import {
  DotsIcon,
  PlusIcon,
  TrashIcon,
  alertTriangleIcon,
  copyIcon,
  pencilIcon,
  searchIcon,
} from "./icons";

import "./VariablesMenu.scss";

import type { DeleteVariableMode } from "../actions/actionVariables";

const formatUsage = (count: number) =>
  count === 0
    ? t("variables.unused")
    : t(count === 1 ? "variables.useOne" : "variables.useMany", { count });

const UsageBadge = ({ count }: { count: number }) => (
  <span
    className={clsx("VariablesMenu__badge", {
      "VariablesMenu__badge--muted": count === 0,
    })}
  >
    {formatUsage(count)}
  </span>
);

const VariableCard = ({
  variable,
  usage,
  isDuplicate,
  readOnly,
  isRenaming,
  onStartRename,
  onEndRename,
  onDelete,
}: {
  variable: ExcalidrawVariableElement;
  usage: number;
  isDuplicate: boolean;
  readOnly: boolean;
  isRenaming: boolean;
  onStartRename: () => void;
  onEndRename: () => void;
  onDelete: () => void;
}) => {
  const app = useApp();
  const actionManager = useExcalidrawActionManager();
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const [draftValue, setDraftValue] = useState<string | null>(null);
  const [draftName, setDraftName] = useState(variable.name);

  const normalizedDraftName = normalizeVariableName(draftName);
  const nameError =
    normalizedDraftName === variable.name
      ? null
      : !isValidVariableName(normalizedDraftName)
      ? t("variables.nameInvalid")
      : app.scene
          .getVariableElements()
          .some(
            (element) =>
              element.id !== variable.id &&
              element.name === normalizedDraftName,
          )
      ? t("variables.nameTaken")
      : null;

  const commitValue = () => {
    if (draftValue !== null && draftValue !== variable.value) {
      actionManager.executeAction(actionUpdateVariable, "ui", {
        id: variable.id,
        value: draftValue,
      });
    }
    setDraftValue(null);
  };

  const endRename = (commit: boolean) => {
    if (commit && !nameError && normalizedDraftName !== variable.name) {
      actionManager.executeAction(actionRenameVariable, "ui", {
        id: variable.id,
        name: normalizedDraftName,
      });
    }
    setDraftName(variable.name);
    onEndRename();
  };

  return (
    <div
      className="VariablesMenu__card"
      data-testid={`variable-row-${variable.name}`}
    >
      <div className="VariablesMenu__card-header">
        {isRenaming ? (
          <input
            className={clsx(
              "VariablesMenu__field VariablesMenu__name-input",
              nameError && "VariablesMenu__field--invalid",
            )}
            aria-label={t("variables.namePlaceholder")}
            aria-invalid={!!nameError}
            title={nameError ?? undefined}
            value={draftName}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={() => endRename(true)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === KEYS.ENTER) {
                endRename(true);
              } else if (event.key === KEYS.ESCAPE) {
                endRename(false);
              }
            }}
          />
        ) : (
          <span className="VariablesMenu__name" title={variable.name}>
            {`{{${variable.name}}}`}
          </span>
        )}
        {isDuplicate && (
          <span
            className="VariablesMenu__warning"
            title={t("variables.duplicate")}
            aria-label={t("variables.duplicate")}
          >
            {alertTriangleIcon}
          </span>
        )}
        {!isRenaming && <UsageBadge count={usage} />}
        <DropdownMenu open={isMenuOpen}>
          <DropdownMenu.Trigger
            className="VariablesMenu__menu-trigger"
            onToggle={() => setIsMenuOpen(!isMenuOpen)}
            aria-label={`${t("variables.more")}: ${variable.name}`}
            title={t("variables.more")}
            data-testid={`variable-menu-${variable.name}`}
          >
            {DotsIcon}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content
            onClickOutside={() => setIsMenuOpen(false)}
            onSelect={() => setIsMenuOpen(false)}
          >
            {!readOnly && (
              <DropdownMenu.Item
                icon={pencilIcon}
                onSelect={() => {
                  setDraftName(variable.name);
                  onStartRename();
                }}
                data-testid="variable-menu-rename"
              >
                {t("variables.rename")}
              </DropdownMenu.Item>
            )}
            <DropdownMenu.Item
              icon={copyIcon}
              onSelect={() =>
                copyTextToSystemClipboard(`{{${variable.name}}}`).catch(
                  () => {},
                )
              }
              data-testid="variable-menu-copy"
            >
              {t("variables.copyReference")}
            </DropdownMenu.Item>
            {!readOnly && (
              <>
                <DropdownMenu.Separator />
                <DropdownMenu.Item
                  icon={TrashIcon}
                  className="VariablesMenu__danger"
                  onSelect={onDelete}
                  data-testid="variable-menu-delete"
                >
                  {t("variables.delete")}
                </DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu>
      </div>
      <input
        className="VariablesMenu__field"
        aria-label={`${t("variables.valuePlaceholder")}: ${variable.name}`}
        placeholder={t("variables.valuePlaceholder")}
        readOnly={readOnly}
        value={draftValue ?? variable.value}
        onChange={(event) => setDraftValue(event.target.value)}
        onBlur={commitValue}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === KEYS.ENTER) {
            commitValue();
            event.currentTarget.blur();
          } else if (event.key === KEYS.ESCAPE) {
            setDraftValue(null);
            event.currentTarget.blur();
          }
        }}
      />
      {nameError && isRenaming && (
        <div className="VariablesMenu__error" role="alert">
          {nameError}
        </div>
      )}
    </div>
  );
};

const DeleteVariableDialog = ({
  variable,
  usage,
  onClose,
}: {
  variable: ExcalidrawVariableElement;
  usage: number;
  onClose: () => void;
}) => {
  const actionManager = useExcalidrawActionManager();
  const [mode, setMode] = useState<DeleteVariableMode>("keep");

  return (
    <ConfirmDialog
      title={t("variables.deleteTitle", { name: variable.name })}
      confirmText={t("variables.delete")}
      onCancel={onClose}
      onConfirm={() => {
        actionManager.executeAction(actionDeleteVariable, "ui", {
          id: variable.id,
          mode,
        });
        onClose();
      }}
    >
      <p>{t("variables.deleteDescription", { count: usage })}</p>
      <div className="VariablesMenu__delete-modes" role="radiogroup">
        {(["keep", "inline"] as const).map((value) => (
          <label key={value}>
            <input
              type="radio"
              name="variable-delete-mode"
              checked={mode === value}
              onChange={() => setMode(value)}
              data-testid={`variable-delete-${value}`}
            />
            {t(
              value === "keep"
                ? "variables.deleteKeep"
                : "variables.deleteInline",
            )}
          </label>
        ))}
      </div>
    </ConfirmDialog>
  );
};

export const VariablesMenu = () => {
  const app = useApp();
  const appState = useExcalidrawAppState();
  const actionManager = useExcalidrawActionManager();
  const readOnly = appState.viewModeEnabled;

  // variables are not part of the (non-deleted) elements of the contexts
  const sceneNonce = useSyncExternalStore(
    (onChange) => app.scene.onUpdate(onChange),
    () => app.scene.getSceneNonce(),
  );

  const [filter, setFilter] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { variables, usage, missing, duplicateIds } = useMemo(() => {
    const variables = app.scene.getVariableElements();
    const usage = countVariableUsage(app.scene.getElementsIncludingDeleted());
    const nameCounts = new Map<string, number>();
    for (const { name } of variables) {
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
    return {
      variables,
      usage,
      missing: Array.from(usage.keys()).filter((name) => !nameCounts.has(name)),
      duplicateIds: new Set(
        variables
          .filter(({ name }) => nameCounts.get(name)! > 1)
          .map(({ id }) => id),
      ),
    };
    // the scene is mutable, the nonce is what tells it has changed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app, sceneNonce]);

  const query = filter.trim().toLowerCase();
  const filteredVariables = query
    ? variables.filter(
        (variable) =>
          variable.name.toLowerCase().includes(query) ||
          variable.value.toLowerCase().includes(query),
      )
    : variables;
  const filteredMissing = query
    ? missing.filter((name) => name.toLowerCase().includes(query))
    : missing;

  const addVariable = (name?: string, value?: string) => {
    const nextName =
      name ??
      getAvailableVariableName(
        app.scene.getElementsIncludingDeleted(),
        "variable",
      );
    actionManager.executeAction(actionCreateVariable, "ui", {
      name: nextName,
      value,
    });
    return app.scene.getVariableElements().find((v) => v.name === nextName);
  };

  const deletingVariable = deletingId
    ? variables.find((variable) => variable.id === deletingId)
    : null;

  return (
    <div className="VariablesMenu" data-testid="variables-menu">
      <div className="VariablesMenu__header">
        <TextField
          className="VariablesMenu__filter"
          value={filter}
          placeholder={t("variables.filterPlaceholder")}
          icon={searchIcon}
          onChange={setFilter}
          fullWidth
        />
        {!readOnly && (
          <button
            type="button"
            className="VariablesMenu__add"
            aria-label={t("variables.add")}
            title={t("variables.add")}
            data-testid="variable-add"
            onClick={() => {
              setFilter("");
              const created = addVariable();
              if (created) {
                setRenamingId(created.id);
              }
            }}
          >
            {PlusIcon}
          </button>
        )}
      </div>
      <div className="VariablesMenu__list" ref={listRef}>
        {!filteredVariables.length && !filteredMissing.length && (
          <div className="VariablesMenu__empty">
            {t(variables.length ? "variables.noMatch" : "variables.empty")}
          </div>
        )}
        {filteredVariables.map((variable) => (
          <VariableCard
            key={variable.id}
            variable={variable}
            usage={usage.get(variable.name) ?? 0}
            isDuplicate={duplicateIds.has(variable.id)}
            readOnly={readOnly}
            isRenaming={renamingId === variable.id}
            onStartRename={() => setRenamingId(variable.id)}
            onEndRename={() => setRenamingId(null)}
            onDelete={() => {
              if (usage.get(variable.name)) {
                setDeletingId(variable.id);
              } else {
                actionManager.executeAction(actionDeleteVariable, "ui", {
                  id: variable.id,
                });
              }
            }}
          />
        ))}
        {filteredMissing.length > 0 && (
          <div
            className="VariablesMenu__missing"
            data-testid="variables-missing"
          >
            <div className="VariablesMenu__section-title">
              {t("variables.missing")}
            </div>
            <div className="VariablesMenu__section-description">
              {t("variables.missingDescription")}
            </div>
            {filteredMissing.map((name) => (
              <div
                className="VariablesMenu__card VariablesMenu__card--missing"
                key={name}
                data-testid={`variable-missing-${name}`}
              >
                <div className="VariablesMenu__card-header">
                  <span className="VariablesMenu__name" title={name}>
                    {`{{${name}}}`}
                  </span>
                  <UsageBadge count={usage.get(name) ?? 0} />
                  {!readOnly && (
                    <button
                      type="button"
                      className="VariablesMenu__create"
                      onClick={() => addVariable(name)}
                    >
                      {t("variables.create")}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="VariablesMenu__hint">
        {t("variables.hintPrefix")} <code>{"{{"}</code>{" "}
        {t("variables.hintSuffix")}
      </div>
      {deletingVariable && (
        <DeleteVariableDialog
          variable={deletingVariable}
          usage={usage.get(deletingVariable.name) ?? 0}
          onClose={() => setDeletingId(null)}
        />
      )}
    </div>
  );
};
