import { useCallback, useEffect, useRef, useState } from 'react';

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: unknown;
}

/**
 * Loads data from the API, with loading and error state handled once.
 *
 * Two correctness details that are easy to get wrong per-screen and are
 * therefore solved here, once:
 *
 *  1. STALE-RESPONSE GUARD. If a request is superseded (the user changes a
 *     filter mid-flight), the older response must not overwrite the newer one.
 *     A monotonically increasing request id makes late replies discard
 *     themselves.
 *
 *  2. UNMOUNT GUARD. Setting state after unmount is a React warning and a leak.
 *     The mounted ref prevents it.
 */
export function useAsync<T>(
  loader: () => Promise<T>,
  dependencies: readonly unknown[] = [],
): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    loading: true,
    error: null,
  });

  const mounted = useRef(true);
  const requestId = useRef(0);
  const [reloadToken, setReloadToken] = useState(0);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const id = ++requestId.current;
    setState((previous) => ({ ...previous, loading: true, error: null }));

    loaderRef
      .current()
      .then((data) => {
        // Discard a response that a newer request has already superseded.
        if (!mounted.current || id !== requestId.current) return;
        setState({ data, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (!mounted.current || id !== requestId.current) return;
        setState({ data: null, loading: false, error });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, reloadToken]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  return { ...state, reload };
}

/**
 * Runs a one-shot action — a transfer, an accept, a login.
 *
 * Separate from `useAsync` because a mutation has different semantics: it fires
 * on a user gesture rather than on mount, and its in-flight state must disable
 * the control that triggered it.
 *
 * `pending` is what a caller binds to a button's `loading` prop, so a
 * double-click cannot produce a second request.
 */
export function useAction<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => Promise<TResult>,
): {
  run: (...args: TArgs) => Promise<TResult | null>;
  pending: boolean;
  error: unknown;
  result: TResult | null;
  reset: () => void;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<TResult | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const actionRef = useRef(action);
  actionRef.current = action;

  const run = useCallback(async (...args: TArgs): Promise<TResult | null> => {
    setPending(true);
    setError(null);

    try {
      const value = await actionRef.current(...args);
      if (mounted.current) setResult(value);
      return value;
    } catch (caught) {
      if (mounted.current) setError(caught);
      return null;
    } finally {
      if (mounted.current) setPending(false);
    }
  }, []);

  const reset = useCallback(() => {
    setError(null);
    setResult(null);
  }, []);

  return { run, pending, error, result, reset };
}
