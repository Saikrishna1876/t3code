import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { persistClientSettingsPatch, useClientSettings } from "../../hooks/useSettings";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function ForkUpdateSettings() {
  const settings = useClientSettings();
  const { environments } = useEnvironments();
  const projects = useProjects().filter((project) => !project.archivedAt);
  const selected = settings.forkUpdateProject;
  const selectedProject = projects.find(
    (project) =>
      project.id === selected?.projectId && project.environmentId === selected.environmentId,
  );
  return (
    <>
      <SettingsRow
        {...searchableSetting("fork-update-project")}
        description="Project where the update button opens a thread to update your fork."
        control={
          <Select
            value={selected ? scopedProjectKey(selected) : "none"}
            onValueChange={(value) => {
              const project = projects.find(
                (item) => scopedProjectKey(scopeProjectRef(item.environmentId, item.id)) === value,
              );
              void persistClientSettingsPatch({
                forkUpdateProject: project
                  ? {
                      environmentId: project.environmentId,
                      projectId: project.id,
                    }
                  : null,
              });
            }}
          >
            <SelectTrigger size="sm" aria-label="Fork update project">
              <SelectValue>
                {selectedProject?.title ?? (selected ? "Project unavailable" : "Choose project")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="none">Choose project</SelectItem>
              {projects.map((project) => {
                const key = scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
                return (
                  <SelectItem key={key} value={key}>
                    {project.title} ·{" "}
                    {environments.find((item) => item.environmentId === project.environmentId)
                      ?.label ?? project.environmentId}{" "}
                    · {project.workspaceRoot}
                  </SelectItem>
                );
              })}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("fork-update-prompt")}
        description="Instructions used when an upstream release is missing from your fork."
      >
        <div className="mt-3 max-w-2xl pb-3.5">
          <Textarea
            key={settings.forkUpdatePrompt}
            aria-label="Fork update prompt"
            rows={5}
            defaultValue={settings.forkUpdatePrompt}
            placeholder="Enter instructions for updating your fork."
            onBlur={(event) => {
              void persistClientSettingsPatch({ forkUpdatePrompt: event.target.value });
            }}
          />
        </div>
      </SettingsRow>
      <SettingsRow
        {...searchableSetting("fork-update-draft-only")}
        description="On opens a draft for you to send. Off sends the prompt immediately."
        control={
          <Switch
            checked={settings.forkUpdateDraftOnly}
            aria-label="Review fork update prompt before sending"
            onCheckedChange={(checked) => {
              void persistClientSettingsPatch({ forkUpdateDraftOnly: checked });
            }}
          />
        }
      />
    </>
  );
}
