import { BarChartHorizontalIcon, BubbleChatIcon, ComputerIcon, DatabaseImportIcon, Home01Icon, Moon02Icon, Plant02Icon, Search01Icon, SearchAreaIcon, Settings02Icon, SidebarLeftIcon, Sun03Icon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { post, type Status } from "@/lib/api";
import type { ThemeChoice } from "@/lib/theme";
import { cn } from "@/lib/utils";

const NAV: { href: string; page: string; title: string; icon: IconSvgElement }[] = [
  { href: "#/home", page: "home", title: "home", icon: Home01Icon },
  { href: "#/runs", page: "runs", title: "runs", icon: BarChartHorizontalIcon },
  { href: "#/search", page: "search", title: "search", icon: Search01Icon },
  { href: "#/checks", page: "checks", title: "checks", icon: SearchAreaIcon },
  { href: "#/agents", page: "agents", title: "coding agents", icon: BubbleChatIcon },
  { href: "#/add-data", page: "add-data", title: "add data", icon: DatabaseImportIcon },
  { href: "#/settings", page: "settings", title: "settings", icon: Settings02Icon },
];

const NAV_HOVER_CLASS = "hover:bg-sidebar-accent hover:text-foreground dark:hover:bg-sidebar-accent";
const NEXT: Record<ThemeChoice, ThemeChoice> = { system: "light", light: "dark", dark: "system" };
const THEME_ICON = { system: ComputerIcon, light: Sun03Icon, dark: Moon02Icon };

/** The app sidebar, as in the Neatlogs app: identity, lowercase nav, and live state in the footer. */
export function AppSidebar({
  page,
  status,
  connected,
  theme,
  setTheme,
  onSettingsChanged,
}: {
  page: string;
  status?: Status;
  connected: boolean;
  theme: ThemeChoice;
  setTheme: (t: ThemeChoice) => void;
  onSettingsChanged: () => void;
}) {
  const { open, toggleSidebar } = useSidebar();
  const llm = status?.engine?.llm;
  const hosted = llm?.where && llm.where !== "local";
  return (
    <Sidebar className="bg-surface-subtle" collapsible="icon" variant="inset">
      <SidebarHeader className="mt-2 px-3 pt-1 pb-4 group-data-[collapsible=icon]:mt-1 group-data-[collapsible=icon]:px-2">
        <div className={cn("flex w-full", open ? "items-center gap-2" : "justify-center pt-1")}>
          <a href="#/home" className="flex min-w-0 flex-1 items-center gap-2 rounded-md" aria-label="neatroots home">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-inverse-surface text-inverse-surface-foreground">
              <Icon icon={Plant02Icon} size="sm" />
            </span>
            {open && (
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-pixel text-sm text-foreground">neatroots</span>
                <span className="truncate text-2xs text-muted-foreground">local · this machine</span>
              </span>
            )}
          </a>
          {open && (
            <button aria-label="Collapse sidebar" className="shrink-0 cursor-pointer text-muted-foreground transition-colors hover:text-foreground" onClick={toggleSidebar} type="button">
              <Icon icon={SidebarLeftIcon} size="md" />
            </button>
          )}
        </div>
      </SidebarHeader>

      <SidebarContent className="gap-4 px-4 font-normal group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:gap-3 group-data-[collapsible=icon]:px-2">
        <SidebarGroup className="p-0 group-data-[collapsible=icon]:px-0">
          <SidebarMenu className="gap-1 text-sm group-data-[collapsible=icon]:items-center">
            {NAV.map((item) => {
              const active = page === item.page;
              return (
                <SidebarMenuItem key={item.page}>
                  <SidebarMenuButton
                    asChild
                    isActive={active}
                    tooltip={{ children: item.title, side: "right", sideOffset: 8 }}
                    className={cn(
                      "group/menu-button relative overflow-hidden rounded-sm transition-colors group-data-[state=expanded]:px-2 group-data-[state=expanded]:py-1",
                      active ? "bg-surface-active text-foreground" : cn("text-muted-foreground", NAV_HOVER_CLASS),
                    )}
                  >
                    <a href={item.href} className="group-data-[state=expanded]:gap-2">
                      <Icon icon={item.icon} className={cn("h-4 w-4 shrink-0", active ? "text-foreground" : "text-muted-foreground group-hover/menu-button:text-foreground")} />
                      <span className={cn("font-pixel text-sm font-normal whitespace-nowrap group-data-[collapsible=icon]:hidden", active ? "text-foreground" : "text-muted-foreground")}>{item.title}</span>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="gap-2 px-4 pb-3 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-2">
        {open && (
          <div className="flex flex-col gap-1.5 px-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-2" title={connected ? "Live updates connected" : "Reconnecting to neatroots"}>
              <span aria-hidden className={cn("size-1.5 rounded-full", connected ? "bg-success-fg" : "bg-danger-fg")} />
              {connected ? "live" : "reconnecting…"}
            </span>
            <a href="#/settings/models" className="flex min-w-0 items-center gap-2 hover:text-foreground" title={llm?.error ?? "Where LLM work runs"}>
              <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", !status ? "bg-foreground-subtle" : llm?.ok ? "bg-success-fg" : "bg-warning-fg")} />
              <span className="truncate font-mono">{!status ? "…" : llm?.ok ? llm.model : "no LLM"}</span>
              {hosted && <span className="shrink-0 text-muted-foreground">hosted</span>}
            </a>
          </div>
        )}
        <SidebarSeparator className="mx-0 group-data-[collapsible=icon]:hidden" />
        <div className="flex items-center gap-1 group-data-[collapsible=icon]:flex-col">
          {open && status && (
            <label className="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1 text-sm text-muted-foreground hover:bg-sidebar-accent">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="font-pixel">steering</span>
                </TooltipTrigger>
                <TooltipContent side="top" align="start">
                  When a check fires mid-run, neatroots adds a short note to the agent's next model call. This needs the project's steering hook.
                </TooltipContent>
              </Tooltip>
              <Switch
                aria-label="Steering for all projects"
                checked={status.steering.enabled}
                onCheckedChange={async (v) => {
                  await post("/api/settings", { steering_enabled: v });
                  toast.success(v ? "Steering is on for projects that enabled it" : "Steering is off everywhere; nothing is sent to agents");
                  onSettingsChanged();
                }}
              />
            </label>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`Theme: ${theme}. Switch to ${NEXT[theme]}`}
                onClick={() => setTheme(NEXT[theme])}
                className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
              >
                <Icon icon={THEME_ICON[theme]} size="sm" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {theme === "system"
                ? "Theme follows your device. Click to cycle through light and dark."
                : "Theme is " + theme + ". Click to cycle through system, light, and dark."}
            </TooltipContent>
          </Tooltip>
          {!open && (
            <button type="button" aria-label="Expand sidebar" onClick={toggleSidebar} className="flex size-8 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-sidebar-accent hover:text-foreground">
              <Icon icon={SidebarLeftIcon} size="sm" />
            </button>
          )}
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
