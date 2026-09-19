import { create } from "zustand";

/**
 * Counts the shell shows as badges — the More tab's dot for unread tasks
 * (doc 02 §1.1 row 14: the tasks screen "drives the bottom-nav badge") and,
 * for whoever wires the bell, unread notifications.
 *
 * "Unread" is the web's definition (lib/repo/tasks.ts unreadTaskCountForUser,
 * served by GET /api/tasks/unread-count): tasks assigned to ME, still open or
 * in progress, that I have not looked at since they were assigned. NOT every
 * open task in the branch — for a manager that would be a permanent "9+"
 * saying nothing. Opening the tasks screen POSTs /api/tasks/seen and the
 * count drops to zero, exactly as on the web.
 *
 * A store rather than a prop because the writer and the reader live in
 * different trees: BottomNav owns the polling query and writes; the tasks
 * screen reads it to know whether there is anything to mark seen. Both key
 * off the same TanStack entry (`UNREAD_TASKS_KEY`), so they never disagree —
 * the store is only the seam.
 *
 * Nothing here is persisted: a badge that survives a cold start would be a
 * stale promise until the first fetch answers, and the fetch answers within
 * the first second anyway. BottomNav resets it on unmount (sign-out) so the
 * next account never inherits the previous one's count.
 */
interface BadgesState {
  /** Tasks assigned to me that I have not seen yet. 0 until fetched. */
  tasksUnread: number;
  /** Unread notifications. Reserved for the bell; nothing writes it yet. */
  notificationsUnread: number;
  setTasksUnread: (count: number) => void;
  setNotificationsUnread: (count: number) => void;
  /** Sign-out / tenant change: a badge from the previous session must not linger. */
  reset: () => void;
}

const EMPTY = { tasksUnread: 0, notificationsUnread: 0 };

export const useBadges = create<BadgesState>((set) => ({
  ...EMPTY,
  setTasksUnread: (count) => set({ tasksUnread: Math.max(0, count) }),
  setNotificationsUnread: (count) => set({ notificationsUnread: Math.max(0, count) }),
  reset: () => set(EMPTY),
}));

/**
 * GET /api/tasks/unread-count. Under the `["tasks"]` prefix on purpose: the
 * tasks screen's own mutations invalidate `["tasks"]`, and a done/reopen must
 * move this count too.
 */
export const UNREAD_TASKS_KEY = ["tasks", "unread-count"] as const;

/**
 * The one definition of "open" the tasks screen uses for its open/done split.
 * Server TaskStatus is open | in_progress | done | cancelled; the web groups
 * only open + in_progress as open (TasksTab.tsx openCount) and has no
 * cancelled column, so `status !== "done"` would count cancelled as open.
 */
export const isOpenTask = (task: { status: string }): boolean =>
  task.status === "open" || task.status === "in_progress";

/** Web parity (MobileBottomNav): two digits would not fit a 16px pill. */
export function badgeText(count: number): string {
  return count > 9 ? "9+" : String(count);
}
