import { CodespacesError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/** Lifecycle operations exclude provider starts and changes to every shared project binding. */
export function makeWorkspaceReservations() {
  const projects = new Map<string, string>();
  const targets = new Map<string, string>();
  const work = new Map<string, number>();
  const busy = () =>
    new CodespacesError({
      code: "busy",
      message:
        "Workspace work or a Codespaces operation is already running. Wait before changing targets.",
    });
  return {
    reserve: (
      id: string,
      projectIds: readonly string[],
      names: readonly string[],
      extend = false,
    ) =>
      Effect.suspend(() => {
        const acquiredProjects: string[] = [];
        const acquiredTargets: string[] = [];
        const conflicts = (holder: string | undefined) =>
          holder !== undefined && !(extend && holder === id);
        return Effect.acquireRelease(
          Effect.sync(() => {
            if (
              projectIds.some((key) => conflicts(projects.get(key)) || work.has(key)) ||
              names.some((key) => conflicts(targets.get(key)))
            )
              return false;
            for (const key of projectIds)
              if (!projects.has(key)) {
                projects.set(key, id);
                acquiredProjects.push(key);
              }
            for (const key of names)
              if (!targets.has(key)) {
                targets.set(key, id);
                acquiredTargets.push(key);
              }
            return true;
          }).pipe(Effect.flatMap((accepted) => (accepted ? Effect.void : Effect.fail(busy())))),
          () =>
            Effect.sync(() => {
              for (const key of acquiredProjects)
                if (projects.get(key) === id) projects.delete(key);
              for (const key of acquiredTargets) if (targets.get(key) === id) targets.delete(key);
            }),
        );
      }),
    acquireWork: (projectId: string) =>
      Effect.acquireRelease(
        Effect.suspend(() => {
          if (projects.has(projectId)) return Effect.fail(busy());
          work.set(projectId, (work.get(projectId) ?? 0) + 1);
          return Effect.void;
        }),
        () =>
          Effect.sync(() => {
            const count = (work.get(projectId) ?? 1) - 1;
            if (count === 0) work.delete(projectId);
            else work.set(projectId, count);
          }),
      ),
    assertBindingAvailable: (projectId: string, name: string | null, owner?: string) =>
      Effect.suspend(() => {
        const holders = [projects.get(projectId), name === null ? undefined : targets.get(name)];
        return holders.some((id) => id !== undefined && id !== owner) || work.has(projectId)
          ? Effect.fail(busy())
          : Effect.void;
      }),
  };
}
