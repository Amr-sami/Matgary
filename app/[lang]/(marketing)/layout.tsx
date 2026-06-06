import type { ReactNode } from "react";
import { LandingNavbar } from "@/components/landing/Navbar";
import { LandingFooter } from "@/components/landing/Footer";

export default function MarketingLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div
      className="min-h-screen flex flex-col bg-white"
      style={{
        backgroundImage: "url(/auth-pattern.svg)",
        backgroundRepeat: "repeat",
      }}
    >
      <LandingNavbar />
      <main className="flex-1">{children}</main>
      <LandingFooter />
    </div>
  );
}
