import { OnboardingContent } from "./OnboardingContent";
import { getOnboardingDefaults } from "../actions";

// Server wrapper: pulls the values the user already supplied at signup
// (currently `tenants.name`) and hands them to the client wizard so we
// don't ask for them a second time. Pure read; safe to render under the
// onboarding gate even when the wizard hasn't been completed yet.
export default async function OnboardingPage() {
  const defaults = await getOnboardingDefaults();
  return <OnboardingContent initialShopName={defaults.shopName} />;
}
