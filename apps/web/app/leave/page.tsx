import { redirect } from "next/navigation";

// Leaves now live as a sub-tab inside /team. Notifications and any older
// bookmarks pointing at /leave land here and bounce to the merged location.
export default function LeavePageRedirect() {
  redirect("/team?tab=leaves");
}
