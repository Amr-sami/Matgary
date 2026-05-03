import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-main px-4 py-10">
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}
