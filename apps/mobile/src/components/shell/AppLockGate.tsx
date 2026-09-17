import type { PropsWithChildren } from "react";

// STUB — owned by the app-lock agent. Wraps the whole navigator: when the
// lock is enabled and the app is cold-started or returns from background,
// render the lock screen instead of children until biometrics/passcode pass.
export function AppLockGate({ children }: PropsWithChildren) {
  return <>{children}</>;
}
