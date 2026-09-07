import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Keeps one broken piece from taking the console with it.
 *
 * React unmounts the whole tree when a render throws, so before this existed a
 * fault anywhere — an overlay, a panel, a chart — left an empty page painted
 * in the shell's background colour. For an operator that is the worst possible
 * failure: indistinguishable from the machine being off, with every working
 * feature taken away along with the broken one.
 *
 * Wrapped, a fault costs only the thing that faulted. The rest of the console
 * keeps running, and the operator is told which part stopped rather than being
 * left to guess.
 */
export class Boundary extends Component<
  { children: ReactNode; name: string; silent?: boolean },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Console, not a toast: this is for whoever is debugging, and the operator
    // already sees the notice below.
    console.error(`[${this.props.name}] crashed`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    // Overlays and other non-essential furniture disappear quietly — a fault
    // in the walkthrough should not park an error card over the live map.
    if (this.props.silent) return null;

    return (
      <div
        className="m-2 rounded-[6px] p-3 text-[11.5px]"
        style={{
          background: 'var(--surface-2)',
          border: '1px solid var(--alert)',
          color: 'var(--text-dim)',
        }}
      >
        <div className="mb-1 font-medium" style={{ color: 'var(--alert)' }}>
          {this.props.name} stopped
        </div>
        The rest of the console is unaffected. Details are in the browser
        console.
      </div>
    );
  }
}
