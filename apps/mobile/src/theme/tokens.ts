/**
 * The design tokens, measured from the running web app.
 *
 * Every hex here was pixel-sampled from a screenshot, not copied from a
 * stylesheet — see mobile-dev-docs/03-design-system.md, which records the exact
 * PNG and coordinate each value came from. Do not "tidy" these: the border is a
 * warm beige-grey on purpose and is the most identity-carrying colour after the
 * blue.
 */

export const colors = {
  /** Page and card ground. There is no grey app canvas — cards sit on white. */
  bg: "#FFFFFF",
  card: "#FFFFFF",

  text: "#1A1A1A",
  textSecondary: "#6B6B6B",

  /** Primary action, active state, links, brand. 9.78:1 on white — AAA. */
  accent: "#1203E3",
  /** Web hover. On native this is the PRESSED state. */
  accentPressed: "#0E02B5",
  accentLight: "#E7E6FC",

  danger: "#C0392B",
  dangerLight: "#FDEAEA",

  success: "#27AE60",
  successLight: "#EAFAF1",
  /** #27AE60 is only 2.87:1 on white and fails AA as text. Use this instead. */
  successStrong: "#1E8449",

  warning: "#FF6900",
  warningStrong: "#CA3500",
  warningLight: "#FFF7ED",
  warningTint: "#FFEDD4",

  neutralTint: "#F3F4F6",
  neutralText: "#374151",

  /** Every card, input and chip border. Warm, not neutral grey. */
  border: "#E8E4DC",
} as const;

export const radius = {
  md: 8,
  /** Cards, tab containers, dropdowns, info banners — 133 usages on the web. */
  lg: 12,
  /** Modals and bottom sheets. */
  xl: 16,
  full: 9999,
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
} as const;

/**
 * Cairo carries ~95% of the app. Tajawal is marketing-only and Lemonada is
 * literally one word on the landing page, so neither is bundled here.
 */
export const fonts = {
  regular: "Cairo_400Regular",
  medium: "Cairo_500Medium",
  semibold: "Cairo_600SemiBold",
  bold: "Cairo_700Bold",
} as const;

/**
 * The web's `--shadow` token is dead — it is declared and never used. These are
 * ports of the Tailwind shadows the app actually applies, paired with the
 * Android elevation that reads closest.
 */
export const elevation = {
  card: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 1,
  },
  dropdown: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 6,
  },
  modal: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.14,
    shadowRadius: 24,
    elevation: 12,
  },
} as const;

/** Minimum touch target. The web still has 348 controls under this — doc 09. */
export const MIN_TOUCH = 44;
