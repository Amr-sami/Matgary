/**
 * Hand-coded flat illustrations for error / empty screens.
 *
 * Style: brand-color (`#1203E3`) on a soft accent-tint (`#E7E6FC`) backdrop,
 * rounded shapes, no AI generation. Replaceable later with real Storyset
 * SVGs by dropping a file at `public/illustrations/<name>.svg` and swapping
 * the component for `<img />` in the consuming page.
 */

const ACCENT = "#1203E3";
const TINT = "#E7E6FC";

interface IllustrationProps {
  className?: string;
}

/** 404 — a magnifying glass with "?" inside, hinting "we couldn't find it". */
export function NotFoundIllustration({ className }: IllustrationProps) {
  return (
    <svg
      viewBox="0 0 240 200"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      {/* soft halo */}
      <ellipse cx="120" cy="180" rx="90" ry="8" fill={TINT} />
      {/* scattered dots */}
      <circle cx="40" cy="40" r="3" fill={ACCENT} opacity="0.25" />
      <circle cx="200" cy="60" r="2.5" fill={ACCENT} opacity="0.35" />
      <circle cx="210" cy="150" r="3" fill={ACCENT} opacity="0.2" />
      <circle cx="30" cy="120" r="2" fill={ACCENT} opacity="0.3" />
      {/* magnifying-glass handle (drawn before glass so it sits behind) */}
      <rect
        x="156"
        y="118"
        width="18"
        height="56"
        rx="9"
        transform="rotate(-45 165 146)"
        fill={ACCENT}
      />
      {/* glass — outer ring */}
      <circle cx="110" cy="95" r="55" fill={TINT} stroke={ACCENT} strokeWidth="6" />
      {/* glass — inner highlight */}
      <circle cx="92" cy="78" r="10" fill="white" opacity="0.7" />
      {/* "?" */}
      <text
        x="110"
        y="118"
        textAnchor="middle"
        fontSize="64"
        fontWeight="900"
        fill={ACCENT}
        fontFamily="system-ui, sans-serif"
      >
        ?
      </text>
    </svg>
  );
}

/** Server / app error — warning triangle with exclamation. */
export function ErrorIllustration({ className }: IllustrationProps) {
  return (
    <svg
      viewBox="0 0 240 200"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <ellipse cx="120" cy="180" rx="95" ry="8" fill={TINT} />
      <circle cx="40" cy="50" r="3" fill={ACCENT} opacity="0.2" />
      <circle cx="195" cy="35" r="2.5" fill={ACCENT} opacity="0.3" />
      <circle cx="200" cy="155" r="3" fill={ACCENT} opacity="0.25" />
      <circle cx="35" cy="135" r="2.5" fill={ACCENT} opacity="0.3" />
      {/* triangle backdrop */}
      <path
        d="M120 30 L205 165 L35 165 Z"
        fill={TINT}
        stroke={ACCENT}
        strokeWidth="6"
        strokeLinejoin="round"
      />
      {/* exclamation bar */}
      <rect x="113" y="70" width="14" height="55" rx="7" fill={ACCENT} />
      {/* exclamation dot */}
      <circle cx="120" cy="143" r="8" fill={ACCENT} />
    </svg>
  );
}

/** Forbidden / 403 — a closed padlock. */
export function ForbiddenIllustration({ className }: IllustrationProps) {
  return (
    <svg
      viewBox="0 0 240 200"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <ellipse cx="120" cy="180" rx="80" ry="8" fill={TINT} />
      <circle cx="40" cy="50" r="3" fill={ACCENT} opacity="0.2" />
      <circle cx="200" cy="50" r="2.5" fill={ACCENT} opacity="0.3" />
      <circle cx="195" cy="150" r="3" fill={ACCENT} opacity="0.25" />
      {/* shackle */}
      <path
        d="M88 90 V70 a32 32 0 0 1 64 0 V90"
        stroke={ACCENT}
        strokeWidth="10"
        strokeLinecap="round"
        fill="none"
      />
      {/* body */}
      <rect
        x="70"
        y="90"
        width="100"
        height="80"
        rx="14"
        fill={TINT}
        stroke={ACCENT}
        strokeWidth="6"
      />
      {/* keyhole */}
      <circle cx="120" cy="125" r="9" fill={ACCENT} />
      <rect x="116" y="130" width="8" height="20" rx="3" fill={ACCENT} />
    </svg>
  );
}

/** Offline / network — wifi waves with a slash. */
export function OfflineIllustration({ className }: IllustrationProps) {
  return (
    <svg
      viewBox="0 0 240 200"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <ellipse cx="120" cy="180" rx="80" ry="8" fill={TINT} />
      {/* wifi arcs */}
      <path
        d="M55 110 a90 90 0 0 1 130 0"
        stroke={ACCENT}
        strokeWidth="9"
        strokeLinecap="round"
        opacity="0.35"
        fill="none"
      />
      <path
        d="M75 130 a60 60 0 0 1 90 0"
        stroke={ACCENT}
        strokeWidth="9"
        strokeLinecap="round"
        opacity="0.55"
        fill="none"
      />
      <path
        d="M95 150 a30 30 0 0 1 50 0"
        stroke={ACCENT}
        strokeWidth="9"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="120" cy="170" r="8" fill={ACCENT} />
      {/* slash */}
      <line
        x1="50"
        y1="55"
        x2="190"
        y2="180"
        stroke="white"
        strokeWidth="14"
        strokeLinecap="round"
      />
      <line
        x1="50"
        y1="55"
        x2="190"
        y2="180"
        stroke={ACCENT}
        strokeWidth="8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Empty data — open box with a single dotted line, friendlier than a 404. */
export function EmptyIllustration({ className }: IllustrationProps) {
  return (
    <svg
      viewBox="0 0 240 200"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <ellipse cx="120" cy="180" rx="85" ry="8" fill={TINT} />
      {/* box back */}
      <path
        d="M55 90 L120 55 L185 90 L185 160 L120 160 L55 160 Z"
        fill={TINT}
        stroke={ACCENT}
        strokeWidth="6"
        strokeLinejoin="round"
      />
      {/* lid creases */}
      <path d="M55 90 L120 125 L185 90" stroke={ACCENT} strokeWidth="6" fill="none" strokeLinejoin="round" />
      <path d="M120 125 V160" stroke={ACCENT} strokeWidth="6" />
      {/* dashed accents floating above */}
      <path d="M85 40 H105" stroke={ACCENT} strokeWidth="5" strokeLinecap="round" strokeDasharray="2 7" />
      <path d="M135 35 H160" stroke={ACCENT} strokeWidth="5" strokeLinecap="round" strokeDasharray="2 7" />
    </svg>
  );
}
