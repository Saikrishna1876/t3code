import type { EnvironmentPresentation } from "~/state/environments";
import { SettingsSection } from "./settingsLayout";
export function CodespacesSettings({
  environments: _environments,
}: {
  environments: readonly EnvironmentPresentation[];
}) {
  return (
    <SettingsSection id="connections-codespaces" title="Codespaces">
      <p className="text-sm text-muted-foreground">
        Open a project's settings or its composer to create or resume a Codespace. Add a
        .devcontainer configuration first. Your agent, login and history stay in this T3
        environment.
      </p>
    </SettingsSection>
  );
}
