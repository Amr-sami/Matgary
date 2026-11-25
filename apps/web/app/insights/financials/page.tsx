// /insights/financials → always lands on Overview.

import { redirect } from "next/navigation";

export default function FinancialsIndex(): never {
  redirect("/insights/financials/overview");
}
