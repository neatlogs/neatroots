import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * Keeps one page's error from blanking the app: the page shows what broke and the sidebar keeps
 * working. The app keys it by route, so moving to another page starts fresh.
 */
export class PageErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("neatroots: this page hit an error", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col px-6 py-16" role="alert">
        <EmptyState
          variant="bordered"
          state="error"
          title="This page hit an error"
          description={`${this.state.error.message || "Something went wrong."} The rest of neatroots still works: pick another page, or reload this one.`}
          action={
            <Button size="sm" onClick={() => window.location.reload()}>
              Reload page
            </Button>
          }
        />
      </div>
    );
  }
}
