import { ComposerControl } from "./chat/ComposerControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";
import { useAtomValue } from "@effect/atom-react";
import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { CloudIcon, PlusIcon, ScaleIcon, ChevronDownIcon } from "lucide-react";
import { memo } from "react";
import { type EnvironmentOption } from "./BranchToolbar.logic";
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

interface BranchToolbarEnvironmentSelectorProps {
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  codespacesProjectId?: ProjectId | undefined;
  codespaceLabel?: string | undefined;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  onAddToMachine?: (() => void) | undefined;
}

export const BranchToolbarEnvironmentSelector = memo(function BranchToolbarEnvironmentSelector({
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  codespacesProjectId,
  codespaceLabel,
  environmentId,
  availableEnvironments,
  onEnvironmentChange,
  onAddToMachine,
}: BranchToolbarEnvironmentSelectorProps) {
  const floating = useComposerMenuProps();
  const shortcut = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "composer.host",
  );
  const active = availableEnvironments.find(
    (environment) => environment.environmentId === environmentId,
  );
  const label = codespaceLabel ?? autoEnvironmentLabel ?? active?.label ?? "Run on";
  const content = (
    <>
      {codespaceLabel ? (
        <CloudIcon className="size-3 shrink-0" />
      ) : autoEnvironmentLabel ? (
        <ScaleIcon className="size-3 shrink-0" />
      ) : (
        <EnvironmentMachineIcon kind={active?.machine ?? "server"} className="size-3 shrink-0" />
      )}
      <ComposerContextLabel>{label}</ComposerContextLabel>
    </>
  );
  if (!codespacesProjectId && (envLocked || (!onEnvironmentChange && !onAddToMachine)))
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className="inline-flex h-7 min-w-0 max-w-full items-center gap-1 border border-transparent px-1.75 text-xs text-muted-foreground/70 sm:h-6"
              data-composer-context-control
            />
          }
        >
          {content}
        </TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
    );
  return (
    <Menu>
      <MenuTrigger
        render={<ComposerControl size="xs" />}
        aria-label="Run on"
        data-composer-shortcut="composer.host"
        data-composer-context-control
      >
        {content}
        <ChevronDownIcon className="size-3 shrink-0" />
      </MenuTrigger>
      <MenuPopup align="start" side="top" {...floating}>
        <MenuGroup>
          <MenuGroupLabel>Run on{shortcut ? ` · ${shortcut}` : ""}</MenuGroupLabel>
          <MenuRadioGroup
            value={codespaceLabel ? "" : autoEnvironmentLabel ? "auto" : environmentId}
            onValueChange={(value) =>
              value === "auto"
                ? onAutoEnvironment?.()
                : onEnvironmentChange?.(value as EnvironmentId)
            }
          >
            {onAutoEnvironment ? (
              <MenuRadioItem value="auto" disabled={envLocked} closeOnClick>
                {autoEnvironmentLabel ?? "Auto balance"}
              </MenuRadioItem>
            ) : null}
            {availableEnvironments.map((environment) => (
              <MenuRadioItem
                key={environment.environmentId}
                value={environment.environmentId}
                disabled={envLocked || !onEnvironmentChange}
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
              Add to another machine
            </MenuItem>
          ) : null}
        </MenuGroup>
        {codespacesProjectId ? (
          <CodespacesMenuItems environmentId={environmentId} projectId={codespacesProjectId} />
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
