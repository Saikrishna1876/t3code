import type { EnvironmentPresentation } from "~/state/environments";
import { SettingsSection } from "./settingsLayout";
export function CodespacesSettings({
  environments,
}: {
  environments: readonly EnvironmentPresentation[];
}) {
  if (
    !environments.some(
      (environment) => environment.serverConfig?.environment.capabilities.codespaces === true,
    )
  )
    return null;
  return (
    <SettingsSection id="connections-codespaces" title="Codespaces">
      <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
        Open a project's settings or its composer to create or resume a Codespace. Add a
        .devcontainer configuration first. Your agent, login and history stay in this T3
        environment.
      </p>
    </SettingsSection>
  );
}
