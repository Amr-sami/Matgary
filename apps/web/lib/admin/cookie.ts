// Edge-safe constants shared between middleware (which runs in the edge
// runtime) and session.ts (which runs in node). Keeping this file free of
// node:* imports is what lets middleware.ts import the cookie name without
// dragging crypto into the edge bundle.

export const ADMIN_SESSION_COOKIE = "__matgary_admin_session";
