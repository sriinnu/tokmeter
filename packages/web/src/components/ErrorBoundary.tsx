import { Component, type ReactNode } from "react";
import { ErrorState } from "./states.js";

interface State {
  error: Error | null;
}

/** Contains a render failure to one route instead of blanking the whole app. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <ErrorState
          art="error"
          title="This view failed to render"
          message={<span className="font-mono text-xs">{this.state.error.message}</span>}
        />
      );
    }
    return this.props.children;
  }
}
