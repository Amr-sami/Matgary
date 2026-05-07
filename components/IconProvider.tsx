"use client";

import type { ReactNode } from "react";
import { IconContext } from "@phosphor-icons/react";

// One place to set the visual style of every icon in the app.
//
// Why "bold":
//  - The brand uses Cairo / Tajawal at heavy weights for headlines; thin
//    icons next to bold Arabic text look anaemic.
//  - Removing the colored "chip" backgrounds from icons (per the latest
//    design pass) left a small visual void — a slightly thicker stroke
//    re-balances each card without re-adding decoration.
//  - Mobile screens favour heavier strokes for legibility at 20px sizes,
//    which is where most of these icons land.
//
// Switching weight (or library) later is a single-file change here.
export function IconProvider({ children }: { children: ReactNode }) {
  return (
    <IconContext.Provider
      value={{
        weight: "bold",
        // Inherit currentColor so Tailwind's text-* classes still drive the colour.
        color: "currentColor",
        size: 20,
        mirrored: false,
      }}
    >
      {children}
    </IconContext.Provider>
  );
}
