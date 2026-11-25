// Mirror of the OS "Reduce Motion" accessibility toggle. Returns true when
// the user has asked the OS to minimise animation, so the skeleton pulse can
// switch to a static appearance.
//
// We subscribe once per mount and track the current value in state so any
// skeleton instance rerenders when the user flips the system setting mid-
// session. AccessibilityInfo on both iOS and Android emits the same event
// name ("reduceMotionChanged") per the RN docs.

import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let mounted = true;

    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => {
        if (mounted) setReduced(v);
      })
      .catch(() => {
        // Device/platform without the API — treat as motion-on.
        if (mounted) setReduced(false);
      });

    const sub = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      (v) => {
        if (mounted) setReduced(v);
      },
    );

    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  return reduced;
}
