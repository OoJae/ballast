import type { MeWire } from "@ballast/api/holder-types";
import { useCallback, useEffect, useState } from "react";
import { errorText, holderGet } from "./api";

/** The signed-in holder's own view (`GET /api/holder/me`), refreshed on demand. */
export function useMe(token: string | null) {
  const [me, setMe] = useState<MeWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    void tick;
    if (!token) {
      setMe(null);
      return;
    }
    let live = true;
    holderGet<MeWire>("me", token)
      .then((m) => {
        if (live) {
          setMe(m);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (live) setError(errorText(err));
      });
    return () => {
      live = false;
    };
  }, [token, tick]);
  return { me, error, refresh };
}
