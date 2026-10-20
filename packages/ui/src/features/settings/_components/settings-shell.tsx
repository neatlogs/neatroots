import type { IconData } from "@/components/ui/icon";
import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// The Neatlogs app's settings frame: a 200px column with grouped links, and pages with a
// sticky header over cards.

export interface SettingsNavItem {
  id: string;
  label: string;
  icon: IconData;
}

export interface SettingsNavGroup {
  label: string;
  items: SettingsNavItem[];
}

export function SettingsLayout({ groups, active, children }: { groups: SettingsNavGroup[]; active: string; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4 md:flex-row">
      <div className="flex shrink-0 flex-col gap-1 overflow-hidden md:w-[200px]">
        <div className="shrink-0 px-4 pt-1 pb-2">
          <span className="font-pixel text-base text-foreground">Settings</span>
        </div>
        <nav aria-label="Settings" className="flex min-h-0 w-full flex-row gap-4 overflow-x-auto px-2 pb-2 md:flex-1 md:flex-col md:overflow-y-auto">
          {groups.map((group) => (
            <div className="flex shrink-0 flex-col gap-1" key={group.label}>
              <p className="px-2 pb-0.5 text-3xs font-medium tracking-caps-wide text-muted-foreground uppercase">{group.label}</p>
              {group.items.map((item) => {
                const isActive = item.id === active;
                return (
                  <a
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                      isActive ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                    )}
                    href={`#/settings/${item.id}`}
                    key={item.id}
                  >
                    <Icon className="shrink-0" icon={item.icon} size="md" />
                    <span className="truncate">{item.label}</span>
                  </a>
                );
              })}
            </div>
          ))}
        </nav>
      </div>
      {/* The scroll area's content is fit-content wide; settings never scroll sideways, so it takes the
          viewport's width and wide pieces (code lines, tables) scroll inside themselves. */}
      <ScrollArea className="-mr-4 -ml-2 min-h-0 min-w-0 flex-1 pr-4 pl-2" viewportClassName="h-full overflow-x-hidden [&>div]:min-w-0!">
        <div className="flex min-h-full flex-col pb-4">{children}</div>
      </ScrollArea>
    </div>
  );
}

export function SettingsPageHeader({ title, description, icon, action }: { title: ReactNode; description?: ReactNode; icon?: IconData; action?: ReactNode }) {
  return (
    <div className="flex shrink-0 items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-2">
        {icon ? (
          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-5">
            <Icon icon={icon} size="md" />
          </span>
        ) : null}
        <div className="min-w-0">
          <h1 className="truncate font-pixel text-base font-normal text-foreground">{title}</h1>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function SettingsPageShell({ header, children, contentWidth = "form", className }: { header: ReactNode; children: ReactNode; contentWidth?: "form" | "full"; className?: string }) {
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-6", contentWidth === "form" && "max-w-3xl", className)}>
      {/* design-allow: hairline inset border-shadow (1px sticky-header bottom rule, not a depth elevation) */}
      <div className="sticky top-0 z-10 -ml-2 bg-background pt-1 pb-3 pl-2 shadow-[inset_0_-1px_0_0_var(--border)]">{header}</div>
      {children}
    </div>
  );
}

const CARD_BASE = "shadow-none transition-colors duration-300 hover:border-border-strong";

/** A settings card: a small caps label, an optional line under it, then the content. */
export function SettingsCard({ title, description, action, children, className, contentClassName }: { title: ReactNode; description?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; contentClassName?: string }) {
  return (
    <Card className={cn(CARD_BASE, className)}>
      <CardHeader className="flex flex-row items-start justify-between gap-4 pb-4">
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle className="font-pixel text-2xs tracking-caps-wide text-muted-foreground uppercase">{title}</CardTitle>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </CardHeader>
      <CardContent className={cn("flex flex-col gap-4", contentClassName)}>{children}</CardContent>
    </Card>
  );
}

/**
 * A feature you turn on or off: icon tile, name, status pill and a line of explanation on the
 * left, the control on the right. The PII master switch pattern.
 */
export function SettingsToggleCard({ icon, title, enabled, status, description, control, children }: { icon: IconData; title: ReactNode; enabled: boolean; status?: ReactNode; description: ReactNode; control: ReactNode; children?: ReactNode }) {
  return (
    <Card className={cn("relative overflow-hidden border shadow-none transition-colors duration-300", enabled && "border-foreground/20")}>
      <CardContent className="flex flex-col gap-4 p-4">
        {/* The controls move under the text when both don't fit (a phone, or two buttons). */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-56 flex-1 basis-0 items-center gap-3">
            <div
              className={cn(
                "flex size-10 shrink-0 items-center justify-center rounded-lg border transition-colors duration-300",
                enabled ? "border-foreground/20 bg-foreground text-background" : "border-border bg-muted/40 text-muted-foreground",
              )}
            >
              <Icon icon={icon} size="md" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-body-medium text-foreground">{title}</p>
                {status ?? (
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-caption font-medium",
                      enabled ? "border-success-border bg-success-surface text-success-fg" : "border-border bg-muted/40 text-muted-foreground",
                    )}
                  >
                    <span className={cn("size-1.5 rounded-full", enabled ? "bg-success-fg" : "bg-muted-foreground")} />
                    {enabled ? "Active" : "Off"}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
            </div>
          </div>
          <div className="shrink-0">{control}</div>
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

export function SettingsLoading({ rows = 2 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-4">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="rounded-xl border bg-card p-5" key={i}>
          <div className="space-y-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-9 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
