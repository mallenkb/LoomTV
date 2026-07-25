import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

type ErrorBoundaryProps = {
  children: ReactNode;
  /** Shown as the panel heading, e.g. "Playback stopped unexpectedly". */
  title: string;
  /** One line telling the user what still works and what to expect next. */
  description: string;
  /** Label for the recovery button. */
  actionLabel?: string;
  /**
   * Positioning for the fallback panel. The default fills its parent, which
   * suits a boundary sitting inside a sized container; overlay boundaries pass
   * `fixed inset-0 z-50` so the panel is not laid out as a flex sibling.
   */
  containerClassName?: string;
  /**
   * Invoked before the boundary resets. A parent uses this to unwind whatever
   * state produced the crash — closing the player, for instance — so retrying
   * does not immediately re-render the same broken subtree.
   */
  onReset?: () => void;
};

type ErrorBoundaryState = { error: Error | null };

/**
 * A packaged Electron renderer has no visible console, so an uncaught render
 * error otherwise leaves the user staring at the black window background with
 * no way back. Each boundary keeps its failure local and offers one action.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[LoomTV] ${this.props.title}`, error, info.componentStack);
  }

  private handleReset = () => {
    this.props.onReset?.();
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const { title, description, actionLabel = 'Try again', containerClassName = 'h-full w-full' } = this.props;
    return (
      <div className={`grid place-items-center bg-[var(--loom-bg)] p-8 text-[var(--loom-text)] ${containerClassName}`}>
        <div className="w-full max-w-md text-center">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-[var(--loom-border)] bg-[var(--loom-surface)]">
            <AlertTriangle className="h-6 w-6 text-[var(--loom-accent)]" />
          </div>
          <h2 className="mt-5 text-lg font-semibold">{title}</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--loom-muted)]">{description}</p>
          <p className="mt-4 truncate rounded-lg border border-[var(--loom-border)] bg-[var(--loom-surface-2)] px-3 py-2 text-left font-mono text-xs text-[var(--loom-faint)]" title={error.message}>
            {error.message || 'Unknown error'}
          </p>
          <button
            type="button"
            onClick={this.handleReset}
            className="mt-6 inline-flex h-10 items-center gap-2 rounded-full bg-[var(--loom-accent)] px-5 text-sm font-semibold text-[var(--loom-accent-foreground)] transition-colors hover:bg-[var(--loom-accent-hover)]"
          >
            <RefreshCw className="h-4 w-4" />
            {actionLabel}
          </button>
        </div>
      </div>
    );
  }
}
