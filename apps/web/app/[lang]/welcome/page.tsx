import { LandingNavbar } from "@/components/landing/Navbar";
import { Hero } from "@/components/landing/Hero";
import { Stats } from "@/components/landing/Stats";
import { Features } from "@/components/landing/Features";
import { Showcase } from "@/components/landing/Showcase";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { Pricing } from "@/components/landing/Pricing";
import { FAQ } from "@/components/landing/FAQ";
import { CTASection } from "@/components/landing/CTASection";
import { LandingFooter } from "@/components/landing/Footer";

// Title + description come from the localized dictionary via the parent
// app/[lang]/layout.tsx generateMetadata.

export default function WelcomePage() {
  return (
    <div
      className="min-h-screen bg-white"
      style={{
        backgroundImage: "url(/auth-pattern.svg)",
        backgroundRepeat: "repeat",
      }}
    >
      <LandingNavbar />
      <main>
        <Hero />
        <Stats />
        <Features />
        <Showcase />
        <HowItWorks />
        <Pricing />
        <FAQ />
        <CTASection />
      </main>
      <LandingFooter />
    </div>
  );
}
