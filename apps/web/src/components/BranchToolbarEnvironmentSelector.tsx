import { ComposerControl, ComposerSelectControl } from "./chat/ComposerControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";
import { useAtomValue } from "@effect/atom-react";
import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { CloudIcon, PlusIcon, ScaleIcon, ChevronDownIcon } from "lucide-react";
import { memo } from "react";
import { T, useGT } from "gt-react";

import { ADD_TO_MACHINE_LABEL_CLASS, type EnvironmentOption } from "./BranchToolbar.logic";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { CodespacesMenuItems } from "./ProjectCodespacesControl";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
} from "./ui/menu";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectValue,
} from "./ui/select";

interface BranchToolbarEnvironmentSelectorProps {
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  codespacesProjectId?: ProjectId | undefined;
  codespaceLabel?: string | undefined;
  codespaceName?: string | null | undefined;
  onCodespaceChange?: ((name: string | null) => void) | undefined;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  onAddToMachine?: (() => void) | undefined;
}

// Action values cannot collide with server-minted environment IDs.
const AUTO_VALUE = "action:auto";
const ADD_MACHINE_VALUE = "action:add-machine";
const environmentValue = (id: EnvironmentId) => `env:${id}`;

export const BranchToolbarEnvironmentSelector = memo(function BranchToolbarEnvironmentSelector({
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  codespacesProjectId,
  codespaceLabel,
  codespaceName,
  onCodespaceChange,
  environmentId,
  availableEnvironments,
  onEnvironmentChange,
  onAddToMachine,
}: BranchToolbarEnvironmentSelectorProps) {
  const gt = useGT();
  const composerFloatingLayerProps = useComposerMenuProps();
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "composer.host",
  );
  const activeEnvironment =
    availableEnvironments.find((env) => env.environmentId === environmentId) ?? null;
  const label = codespaceLabel ?? autoEnvironmentLabel ?? activeEnvironment?.label ?? gt("Run on");

  const environmentItems = [
    ...(onAutoEnvironment
      ? [{ value: AUTO_VALUE, label: autoEnvironmentLabel ?? gt("Auto balance") }]
      : []),
    ...availableEnvironments.map((env) => ({
      value: environmentValue(env.environmentId),
      label: env.label,
    })),
    ...(onAddToMachine ? [{ value: ADD_MACHINE_VALUE, label: gt("Add to another machine") }] : []),
  ];

  // Match the xs control's height and padding: the composer strip has no min-height,
  // and its glass seam assumes that height even when this label is the only control.
  if (
    envLocked ||
    (!codespacesProjectId && onEnvironmentChange === undefined && onAddToMachine === undefined)
  ) {
    const lockedRow = (
      <span
        className="inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-sm sm:h-6 sm:text-xs"
        data-composer-context-control
      >
        {codespaceLabel ? (
          <CloudIcon className="size-3 shrink-0" />
        ) : autoEnvironmentLabel ? (
          <ScaleIcon className="size-3 shrink-0" />
        ) : (
          <EnvironmentMachineIcon
            kind={activeEnvironment?.machine ?? "server"}
            className="size-3 shrink-0"
          />
        )}
        <ComposerContextLabel>{label}</ComposerContextLabel>
      </span>
    );
    return (
      <Tooltip>
        <TooltipTrigger render={lockedRow} />
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
    );
  }

  // Bound Codespace threads need the Codespaces menu, which offers named computers,
  // stopped-computer start, and the current checkout alongside remote worktrees.
  if (codespacesProjectId) {
    const content = (
      <>
        {codespaceLabel ? (
          <CloudIcon className="size-3 shrink-0" />
        ) : autoEnvironmentLabel ? (
          <ScaleIcon className="size-3 shrink-0" />
        ) : (
          <EnvironmentMachineIcon
            kind={activeEnvironment?.machine ?? "server"}
            className="size-3 shrink-0"
          />
        )}
        <ComposerContextLabel>{label}</ComposerContextLabel>
      </>
    );
    return (
      <Menu>
        <MenuTrigger
          render={<ComposerControl size="xs" />}
          aria-label={gt("Run on")}
          data-composer-shortcut="composer.host"
          data-composer-context-control
        >
          {content}
          <ChevronDownIcon className="size-3 shrink-0" />
        </MenuTrigger>
        <MenuPopup align="start" side="top" {...composerFloatingLayerProps}>
          <MenuGroup>
            <MenuGroupLabel>
              <T>Run on</T>
              {shortcutLabel ? ` · ${shortcutLabel}` : ""}
            </MenuGroupLabel>
            <MenuRadioGroup
              value={codespaceLabel ? "" : autoEnvironmentLabel ? AUTO_VALUE : environmentId}
              onValueChange={(value) =>
                value === AUTO_VALUE
                  ? onAutoEnvironment?.()
                  : value === environmentId
                    ? onCodespaceChange?.(null)
                    : onEnvironmentChange?.(value as EnvironmentId)
              }
            >
              {onAutoEnvironment ? (
                <MenuRadioItem value={AUTO_VALUE} disabled={envLocked} closeOnClick>
                  {autoEnvironmentLabel ?? gt("Auto balance")}
                </MenuRadioItem>
              ) : null}
              {availableEnvironments.map((environment) => (
                <MenuRadioItem
                  key={environment.environmentId}
                  value={environment.environmentId}
                  disabled={
                    envLocked ||
                    (!onEnvironmentChange && environment.environmentId !== environmentId)
                  }
                  closeOnClick
                >
                  <EnvironmentMachineIcon kind={environment.machine} className="size-3" />
                  {environment.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            {onAddToMachine ? (
              <MenuItem disabled={envLocked} onClick={onAddToMachine}>
                <PlusIcon className="size-3" />
                <T>Add to another machine</T>
              </MenuItem>
            ) : null}
          </MenuGroup>
          <CodespacesMenuItems
            environmentId={environmentId}
            projectId={codespacesProjectId}
            codespaceName={codespaceName}
            onCodespaceChange={onCodespaceChange}
            locked={envLocked}
          />
        </MenuPopup>
      </Menu>
    );
  }

  return (
    <Select
      modal={false}
      value={autoEnvironmentLabel ? AUTO_VALUE : environmentValue(environmentId)}
      onValueChange={(value) => {
        if (value === ADD_MACHINE_VALUE) {
          onAddToMachine?.();
        } else if (value === AUTO_VALUE) {
          onAutoEnvironment?.();
        } else if (value?.startsWith("env:")) {
          onEnvironmentChange?.(value.slice(4) as EnvironmentId);
        }
      }}
      items={environmentItems}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerSelectControl
              size="xs"
              className="min-w-0 max-w-full"
              aria-label={gt("Run on")}
              data-composer-shortcut="composer.host"
              data-composer-context-control
            />
          }
        >
          {autoEnvironmentLabel ? (
            <ScaleIcon className="size-3 shrink-0" aria-hidden="true" />
          ) : (
            <EnvironmentMachineIcon
              kind={activeEnvironment?.machine ?? "server"}
              className="size-3 shrink-0"
            />
          )}
          <ComposerContextLabel>
            <SelectValue />
          </ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>
          {autoEnvironmentLabel ?? activeEnvironment?.label ?? gt("Run on")}
          {shortcutLabel ? ` · ${shortcutLabel}` : null}
        </TooltipPopup>
      </Tooltip>
      <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
        <SelectGroup>
          <SelectGroupLabel>
            <T>Run on</T>
          </SelectGroupLabel>
          {onAutoEnvironment && (
            <SelectItem
              value={AUTO_VALUE}
              onClick={() => {
                if (autoEnvironmentLabel) onAutoEnvironment?.();
              }}
            >
              <span className="inline-flex items-center gap-1.5">
                <ScaleIcon className="size-3" aria-hidden="true" />
                {autoEnvironmentLabel ?? gt("Auto balance")}
              </span>
            </SelectItem>
          )}
          {availableEnvironments.map((env) => (
            <SelectItem
              key={env.environmentId}
              value={environmentValue(env.environmentId)}
              disabled={onEnvironmentChange === undefined && env.environmentId !== environmentId}
            >
              <span className="inline-flex items-center gap-1.5">
                <EnvironmentMachineIcon kind={env.machine} className="size-3" />
                {env.label}
              </span>
            </SelectItem>
          ))}
          {onAddToMachine ? (
            <SelectItem value={ADD_MACHINE_VALUE}>
              <span className={ADD_TO_MACHINE_LABEL_CLASS}>
                <PlusIcon aria-hidden="true" className="size-3" />
                <T>Add to another machine</T>
              </span>
            </SelectItem>
          ) : null}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
