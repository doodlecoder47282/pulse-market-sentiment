// ErrorBoundary.tsx — React class component error boundary.
// Catches render/lifecycle errors in children and shows a small recovery card.
// Wrap any panel or tab content to isolate failures.

import { Component, type ReactNode, type ErrorInfo } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  /** Optional label to show in error card, e.g. "Chart Panel" */
  label?: string;
  /** Compact variant — smaller card, no label, just icon + retry */
  compact?: boolean;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", this.props.label ?? "panel", error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    const { label = "Panel", compact } = this.props;
    const msg = this.state.error?.message ?? "An unexpected error occurred.";

    if (compact) {
      return (
        <div className="flex items-center gap-2 rounded-md border border-border/60 bg-card/50 px-3 py-2 text-xs text-muted-foreground">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span className="truncate">{msg}</span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 px-2 text-[10px]"
            onClick={this.handleReset}
          >
            <RefreshCw className="mr-1 h-3 w-3" />
            Retry
          </Button>
        </div>
      );
    }

    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-amber-400">{label} failed to render</div>
            <div className="mt-1 text-xs text-muted-foreground truncate">{msg}</div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 border-amber-500/40 text-amber-400 hover:bg-amber-500/10"
            onClick={this.handleReset}
          >
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Retry
          </Button>
        </div>
      </div>
    );
  }
}
