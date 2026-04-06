import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

const RECOVERABLE_DYNAMIC_IMPORT_ERROR =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;

function getRecoveryKey() {
  return `error-boundary-recovery:${window.location.pathname}`;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);

    const message = error instanceof Error ? error.message : String(error ?? "");
    if (!RECOVERABLE_DYNAMIC_IMPORT_ERROR.test(message)) {
      return;
    }

    const recoveryKey = getRecoveryKey();
    if (window.sessionStorage.getItem(recoveryKey) === "1") {
      return;
    }

    window.sessionStorage.setItem(recoveryKey, "1");
    window.setTimeout(() => {
      window.location.reload();
    }, 30);
  }

  render() {
    if (this.state.error) {
      const isRecoverableDynamicImportError = RECOVERABLE_DYNAMIC_IMPORT_ERROR.test(this.state.error.message);
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
          <h1 className="text-2xl font-bold text-destructive">Ops, algo deu errado</h1>
          <p className="max-w-md text-muted-foreground">{this.state.error.message}</p>
          <button
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
            onClick={() => {
              if (isRecoverableDynamicImportError) {
                window.location.reload();
                return;
              }
              this.setState({ error: null });
            }}
          >
            {isRecoverableDynamicImportError ? "Recarregar pagina" : "Tentar novamente"}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
