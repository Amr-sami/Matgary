import { Redirect } from "expo-router";

/**
 * Expo Router's fallback for a URL no route file matches.
 *
 * `+native-intent.ts` already collapses unknown WEB links to "/", but
 * custom-scheme links (`matgary://…`, push-notification payloads) are handed
 * to the router verbatim — so `matgary://index` (the dashboard's file name,
 * not its path: the dashboard is served at `matgary:///`) or any retired
 * route would otherwise dead-end on the stock "Unmatched Route — Page could
 * not be found" screen. Send it home instead; the root Stack's guards then
 * pick the signed-in or signed-out branch as they do for a plain launch.
 */
export default function NotFoundScreen() {
  return <Redirect href="/" />;
}
