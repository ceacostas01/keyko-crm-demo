import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { hasError: boolean; message: string | null };

/**
 * Si una pantalla falla, se muestra un aviso en vez de dejar la app en blanco.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false, message: null };

  static getDerivedStateFromError(error: unknown): State {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : 'Error inesperado',
    };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('screen_error', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="error-screen">
        <div className="card card-pad" style={{ maxWidth: 460 }}>
          <h2 style={{ fontSize: 20, marginBottom: 8 }}>Algo salió mal</h2>
          <p className="muted small" style={{ marginBottom: 14 }}>
            {this.state.message ?? 'La pantalla no pudo cargarse.'}
          </p>
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => window.location.reload()}
            >
              Recargar
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                window.location.href = '/';
              }}
            >
              Ir al inicio
            </button>
          </div>
        </div>
      </div>
    );
  }
}
