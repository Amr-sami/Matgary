import { OfflineDrainer } from "./OfflineDrainer";
import { PushRegistrar } from "./PushRegistrar";
import { SnapshotRefresher } from "./SnapshotRefresher";
import { SuspensionRouter } from "./SuspensionRouter";

/** Every app-wide side effect, mounted once. Each is owned by one feature. */
export function AppEffects() {
  return (
    <>
      <SuspensionRouter />
      <PushRegistrar />
      <OfflineDrainer />
      <SnapshotRefresher />
    </>
  );
}
