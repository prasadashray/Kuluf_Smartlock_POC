import { useEffect, useRef, useState, useCallback } from 'react';

/** Poll an async loader every `ms` (TDD §8: simple polling instead of websockets). */
export function usePoll(loader, ms, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const refresh = useCallback(async () => {
    try {
      setData(await loaderRef.current());
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      if (alive) await refresh();
    };
    run();
    const t = setInterval(run, ms);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, refresh };
}
