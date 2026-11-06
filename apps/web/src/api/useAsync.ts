import { useEffect, useState } from 'react';
import { ApiError } from './client';

export type AsyncState<T> = {
  data: T | null;
  loading: boolean;
  error: ApiError | null;
  reload: () => void;
  setData: (data: T) => void;
};

/**
 * Carga datos de la API con estado de carga y error.
 * `deps` decide cuándo volver a pedir; `reload()` fuerza una recarga.
 */
export function useAsync<T>(
  loader: () => Promise<T>,
  deps: readonly unknown[],
): AsyncState<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);

    loader()
      .then((result) => {
        if (alive) setDataState(result);
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        setError(
          cause instanceof ApiError
            ? cause
            : new ApiError(0, 'unknown', 'Algo salió mal'),
        );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);

  return {
    data,
    loading,
    error,
    reload: () => setVersion((value) => value + 1),
    setData: (next: T) => setDataState(next),
  };
}
