import { AiBrain01Icon, CloudIcon, CommandLineIcon, Folder01Icon, Settings01Icon, Target02Icon } from "@hugeicons/core-free-icons";
import type { Status } from "@/lib/api";
import { AgentsSection } from "./agents-section";
import { CloudSection } from "./cloud-section";
import { DecisionSection } from "./decision-section";
import { GeneralSection } from "./general-section";
import { LlmSection } from "./llm-section";
import { ProjectsSection } from "./projects-section";
import { SettingsLayout, SettingsLoading, SettingsPageHeader, SettingsPageShell, type SettingsNavGroup } from "./settings-shell";

const GROUPS: SettingsNavGroup[] = [
  {
    label: "Workspace",
    items: [
      { id: "general", label: "General", icon: Settings01Icon },
      { id: "projects", label: "Projects", icon: Folder01Icon },
    ],
  },
  {
    label: "Models",
    items: [
      { id: "models", label: "LLM", icon: AiBrain01Icon },
      { id: "decisions", label: "Decision model", icon: Target02Icon },
    ],
  },
  {
    label: "Connections",
    items: [
      { id: "agents", label: "Coding agents", icon: CommandLineIcon },
      { id: "cloud", label: "Neatlogs Cloud", icon: CloudIcon },
    ],
  },
];

const PAGES: Record<string, { title: string; description: string }> = {
  general: { title: "General", description: "Where neatroots listens, where it keeps your runs, and for how long." },
  projects: { title: "Projects", description: "Steering, cloud forwarding and replays, per agent." },
  models: { title: "LLM", description: "Plans which questions fit each agent, explains problems, writes notes for the agent and summarizes runs." },
  decisions: { title: "Decision model", description: "Answers each check's yes/no question with a probability." },
  agents: { title: "Coding agents", description: "Claude Code, Codex, Cursor and others read runs and findings, and add checks, over MCP." },
  cloud: { title: "Neatlogs Cloud", description: "Keep or share runs, and bring production traces here to debug them." },
};

export function SettingsPage({ status, tab: raw }: { status?: Status; tab?: string }) {
  const tab = raw && raw in PAGES ? raw : "general";
  const icon = GROUPS.flatMap((g) => g.items).find((i) => i.id === tab)!.icon;
  const page = PAGES[tab];
  return (
    <SettingsLayout groups={GROUPS} active={tab}>
      <SettingsPageShell header={<SettingsPageHeader icon={icon} title={page.title} description={page.description} />} contentWidth={tab === "projects" || tab === "agents" ? "full" : "form"}>
        {!status ? (
          <SettingsLoading />
        ) : tab === "general" ? (
          <GeneralSection status={status} />
        ) : tab === "projects" ? (
          <ProjectsSection steerPython={status.install?.steer_python} steerTs={status.install?.steer_ts} />
        ) : tab === "models" ? (
          <LlmSection status={status} />
        ) : tab === "decisions" ? (
          <DecisionSection status={status} />
        ) : tab === "agents" ? (
          <AgentsSection port={status.port} />
        ) : (
          <CloudSection status={status} />
        )}
      </SettingsPageShell>
    </SettingsLayout>
  );
}
