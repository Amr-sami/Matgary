/**
 * Hand-coded flat SVG illustrations for the landing page.
 * Style: same brand-color (#1203E3) on accent-tint (#E7E6FC) palette
 * used in the auth/error illustrations. No AI-generated assets.
 */

const ACCENT = "#1203E3";
const TINT = "#E7E6FC";
const SOFT = "#F5F4FE";

interface Props {
  className?: string;
}

/** Inventory boxes — feature: "موحد" inventory + sales. */
export function InventoryArt({ className }: Props) {
  return (
    <svg viewBox="0 0 160 160" fill="none" className={className} aria-hidden>
      <rect width="160" height="160" rx="20" fill={SOFT} />
      <rect x="22" y="80" width="50" height="55" rx="4" fill={TINT} stroke={ACCENT} strokeWidth="3" />
      <rect x="62" y="40" width="55" height="60" rx="4" fill="white" stroke={ACCENT} strokeWidth="3" />
      <rect x="100" y="75" width="42" height="60" rx="4" fill={TINT} stroke={ACCENT} strokeWidth="3" />
      <path d="M22 100 H72 M62 70 H117 M100 105 H142" stroke={ACCENT} strokeWidth="3" />
      {/* "tape" details */}
      <rect x="84" y="40" width="11" height="60" fill={ACCENT} opacity="0.18" />
      <rect x="40" y="80" width="11" height="55" fill={ACCENT} opacity="0.18" />
    </svg>
  );
}

/** POS / receipt — feature: sales & receipts. */
export function SalesArt({ className }: Props) {
  return (
    <svg viewBox="0 0 160 160" fill="none" className={className} aria-hidden>
      <rect width="160" height="160" rx="20" fill={SOFT} />
      {/* receipt */}
      <path
        d="M50 28 H110 V125 L102 132 L94 125 L86 132 L78 125 L70 132 L62 125 L54 132 L50 125 Z"
        fill="white"
        stroke={ACCENT}
        strokeWidth="3"
        strokeLinejoin="round"
      />
      {/* lines */}
      <path d="M60 48 H100" stroke={ACCENT} strokeWidth="3" strokeLinecap="round" />
      <path d="M60 62 H92" stroke={ACCENT} strokeWidth="2.5" opacity="0.55" strokeLinecap="round" />
      <path d="M60 72 H88" stroke={ACCENT} strokeWidth="2.5" opacity="0.55" strokeLinecap="round" />
      <path d="M60 82 H100" stroke={ACCENT} strokeWidth="2.5" opacity="0.55" strokeLinecap="round" />
      <path d="M60 96 H100" stroke={ACCENT} strokeWidth="3" strokeLinecap="round" />
      {/* total badge */}
      <rect x="58" y="104" width="44" height="14" rx="3" fill={ACCENT} />
    </svg>
  );
}

/** Bar chart — feature: insights & reports. */
export function InsightsArt({ className }: Props) {
  return (
    <svg viewBox="0 0 160 160" fill="none" className={className} aria-hidden>
      <rect width="160" height="160" rx="20" fill={SOFT} />
      {/* axes */}
      <path d="M30 30 V128 H132" stroke={ACCENT} strokeWidth="3" strokeLinecap="round" />
      {/* bars */}
      <rect x="46" y="92" width="14" height="36" rx="2" fill={TINT} stroke={ACCENT} strokeWidth="2.5" />
      <rect x="68" y="72" width="14" height="56" rx="2" fill={TINT} stroke={ACCENT} strokeWidth="2.5" />
      <rect x="90" y="58" width="14" height="70" rx="2" fill={ACCENT} />
      <rect x="112" y="44" width="14" height="84" rx="2" fill={TINT} stroke={ACCENT} strokeWidth="2.5" />
      {/* trend line */}
      <path
        d="M50 86 L74 66 L96 50 L120 38"
        stroke={ACCENT}
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="120" cy="38" r="4" fill={ACCENT} />
    </svg>
  );
}

/** Connected people — feature: team & branches. */
export function TeamArt({ className }: Props) {
  return (
    <svg viewBox="0 0 160 160" fill="none" className={className} aria-hidden>
      <rect width="160" height="160" rx="20" fill={SOFT} />
      {/* connections */}
      <path
        d="M55 60 L80 95 M105 60 L80 95 M55 110 L105 110"
        stroke={ACCENT}
        strokeWidth="2.5"
        opacity="0.4"
        strokeDasharray="4 5"
      />
      {/* nodes */}
      <circle cx="55" cy="55" r="18" fill={TINT} stroke={ACCENT} strokeWidth="3" />
      <circle cx="55" cy="49" r="6" fill={ACCENT} />
      <path d="M44 70 q11 -10 22 0" stroke={ACCENT} strokeWidth="3" fill="none" strokeLinecap="round" />

      <circle cx="105" cy="55" r="18" fill={TINT} stroke={ACCENT} strokeWidth="3" />
      <circle cx="105" cy="49" r="6" fill={ACCENT} />
      <path d="M94 70 q11 -10 22 0" stroke={ACCENT} strokeWidth="3" fill="none" strokeLinecap="round" />

      <circle cx="80" cy="115" r="20" fill={ACCENT} />
      <circle cx="80" cy="108" r="7" fill="white" />
      <path d="M68 132 q12 -11 24 0" stroke="white" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  );
}

/** Browser window with storefront — feature: public catalog / custom domain. */
export function CatalogArt({ className }: Props) {
  return (
    <svg viewBox="0 0 160 160" fill="none" className={className} aria-hidden>
      <rect width="160" height="160" rx="20" fill={SOFT} />
      <rect x="20" y="32" width="120" height="96" rx="6" fill="white" stroke={ACCENT} strokeWidth="3" />
      <path d="M20 50 H140" stroke={ACCENT} strokeWidth="3" />
      <circle cx="30" cy="41" r="2.5" fill={ACCENT} opacity="0.4" />
      <circle cx="40" cy="41" r="2.5" fill={ACCENT} opacity="0.4" />
      <circle cx="50" cy="41" r="2.5" fill={ACCENT} opacity="0.4" />
      <rect x="60" y="36" width="70" height="10" rx="2" fill={TINT} />
      {/* product grid */}
      <rect x="32" y="62" width="28" height="28" rx="4" fill={TINT} stroke={ACCENT} strokeWidth="2.5" />
      <rect x="66" y="62" width="28" height="28" rx="4" fill={ACCENT} />
      <rect x="100" y="62" width="28" height="28" rx="4" fill={TINT} stroke={ACCENT} strokeWidth="2.5" />
      <rect x="32" y="98" width="28" height="22" rx="3" fill={TINT} />
      <rect x="66" y="98" width="28" height="22" rx="3" fill={TINT} />
      <rect x="100" y="98" width="28" height="22" rx="3" fill={TINT} />
    </svg>
  );
}

/** Inventory deep-dive: shelves with low-stock badge — for showcase row. */
export function InventoryShowcaseArt({ className }: Props) {
  return (
    <svg viewBox="0 0 400 280" fill="none" className={className} aria-hidden>
      <rect width="400" height="280" rx="20" fill={SOFT} />
      {/* shelf back panel */}
      <rect x="50" y="50" width="300" height="180" rx="8" fill="white" stroke={ACCENT} strokeWidth="3" />
      {/* shelves */}
      <line x1="50" y1="120" x2="350" y2="120" stroke={ACCENT} strokeWidth="3" />
      <line x1="50" y1="180" x2="350" y2="180" stroke={ACCENT} strokeWidth="3" />
      {/* top row boxes */}
      <rect x="68" y="68" width="42" height="42" rx="3" fill={TINT} stroke={ACCENT} strokeWidth="2.5" />
      <rect x="120" y="68" width="42" height="42" rx="3" fill={ACCENT} />
      <rect x="172" y="68" width="42" height="42" rx="3" fill={TINT} stroke={ACCENT} strokeWidth="2.5" />
      <rect x="224" y="68" width="42" height="42" rx="3" fill={TINT} stroke={ACCENT} strokeWidth="2.5" />
      <rect x="276" y="68" width="42" height="42" rx="3" fill={ACCENT} />
      {/* middle row */}
      <rect x="68" y="128" width="42" height="42" rx="3" fill={ACCENT} />
      <rect x="120" y="128" width="42" height="42" rx="3" fill={TINT} stroke={ACCENT} strokeWidth="2.5" />
      <rect x="172" y="128" width="42" height="42" rx="3" fill={TINT} stroke={ACCENT} strokeWidth="2.5" />
      {/* low-stock empty slot */}
      <rect x="224" y="128" width="42" height="42" rx="3" fill="white" stroke={ACCENT} strokeWidth="2.5" strokeDasharray="3 4" />
      <rect x="276" y="128" width="42" height="42" rx="3" fill={TINT} stroke={ACCENT} strokeWidth="2.5" />
      {/* bottom row */}
      <rect x="68" y="188" width="42" height="34" rx="3" fill={TINT} stroke={ACCENT} strokeWidth="2.5" />
      <rect x="120" y="188" width="42" height="34" rx="3" fill={ACCENT} />
      <rect x="172" y="188" width="42" height="34" rx="3" fill={TINT} stroke={ACCENT} strokeWidth="2.5" />
      <rect x="224" y="188" width="42" height="34" rx="3" fill={TINT} stroke={ACCENT} strokeWidth="2.5" />
      <rect x="276" y="188" width="42" height="34" rx="3" fill={TINT} stroke={ACCENT} strokeWidth="2.5" />
      {/* low-stock alert badge */}
      <g transform="translate(245 109)">
        <circle r="22" fill="#FFEBEC" stroke="#C0392B" strokeWidth="3" />
        <rect x="-2" y="-10" width="4" height="14" rx="1.5" fill="#C0392B" />
        <circle cx="0" cy="9" r="2.5" fill="#C0392B" />
      </g>
    </svg>
  );
}

/** POS speed: cash drawer + receipt with motion lines — for showcase row. */
export function PosShowcaseArt({ className }: Props) {
  return (
    <svg viewBox="0 0 400 280" fill="none" className={className} aria-hidden>
      <rect width="400" height="280" rx="20" fill={SOFT} />
      {/* terminal body */}
      <rect x="80" y="100" width="180" height="130" rx="10" fill="white" stroke={ACCENT} strokeWidth="3" />
      {/* screen */}
      <rect x="96" y="116" width="148" height="74" rx="4" fill={TINT} />
      {/* total figure */}
      <rect x="106" y="128" width="50" height="8" rx="2" fill={ACCENT} opacity="0.3" />
      <rect x="106" y="146" width="100" height="14" rx="3" fill={ACCENT} />
      <rect x="106" y="172" width="40" height="6" rx="2" fill={ACCENT} opacity="0.3" />
      {/* keypad */}
      <g fill={ACCENT} opacity="0.85">
        <circle cx="106" cy="210" r="6" />
        <circle cx="130" cy="210" r="6" />
        <circle cx="154" cy="210" r="6" />
        <circle cx="178" cy="210" r="6" />
        <circle cx="202" cy="210" r="6" />
        <circle cx="226" cy="210" r="6" />
      </g>
      {/* receipt sliding out */}
      <path
        d="M260 95 H340 V165 L332 170 L324 165 L316 170 L308 165 L300 170 L292 165 L284 170 L276 165 L268 170 L260 165 Z"
        fill="white"
        stroke={ACCENT}
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path d="M268 110 H332 M268 122 H322 M268 134 H332 M268 146 H316" stroke={ACCENT} strokeWidth="2.5" strokeLinecap="round" opacity="0.7" />
      {/* speed motion lines */}
      <g stroke={ACCENT} strokeWidth="3" strokeLinecap="round" opacity="0.55">
        <line x1="346" y1="50" x2="368" y2="50" />
        <line x1="338" y1="64" x2="376" y2="64" />
        <line x1="346" y1="78" x2="368" y2="78" />
      </g>
    </svg>
  );
}

/** Insights dashboard: chart + KPI cards — for showcase row. */
export function InsightsShowcaseArt({ className }: Props) {
  return (
    <svg viewBox="0 0 400 280" fill="none" className={className} aria-hidden>
      <rect width="400" height="280" rx="20" fill={SOFT} />
      {/* dashboard frame */}
      <rect x="40" y="40" width="320" height="200" rx="10" fill="white" stroke={ACCENT} strokeWidth="3" />
      <line x1="40" y1="68" x2="360" y2="68" stroke={ACCENT} strokeWidth="2.5" />
      <circle cx="54" cy="54" r="3" fill={ACCENT} opacity="0.4" />
      <circle cx="66" cy="54" r="3" fill={ACCENT} opacity="0.4" />
      <circle cx="78" cy="54" r="3" fill={ACCENT} opacity="0.4" />
      {/* KPI cards row */}
      <rect x="56" y="84" width="78" height="46" rx="5" fill={TINT} stroke={ACCENT} strokeWidth="2" />
      <rect x="64" y="92" width="32" height="6" rx="2" fill={ACCENT} opacity="0.5" />
      <rect x="64" y="106" width="50" height="12" rx="2" fill={ACCENT} />

      <rect x="146" y="84" width="78" height="46" rx="5" fill={TINT} stroke={ACCENT} strokeWidth="2" />
      <rect x="154" y="92" width="36" height="6" rx="2" fill={ACCENT} opacity="0.5" />
      <rect x="154" y="106" width="40" height="12" rx="2" fill={ACCENT} />

      <rect x="236" y="84" width="78" height="46" rx="5" fill={ACCENT} />
      <rect x="244" y="92" width="34" height="6" rx="2" fill="white" opacity="0.6" />
      <rect x="244" y="106" width="46" height="12" rx="2" fill="white" />
      {/* chart area */}
      <rect x="56" y="146" width="288" height="78" rx="6" fill={TINT} />
      {/* axis */}
      <path d="M68 218 H332" stroke={ACCENT} strokeWidth="2" opacity="0.4" />
      {/* trend line */}
      <path
        d="M68 200 L108 188 L148 196 L188 172 L228 178 L268 158 L308 162 L332 142"
        stroke={ACCENT}
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* trend area fill */}
      <path
        d="M68 200 L108 188 L148 196 L188 172 L228 178 L268 158 L308 162 L332 142 L332 218 L68 218 Z"
        fill={ACCENT}
        opacity="0.10"
      />
      {/* dot at last point */}
      <circle cx="332" cy="142" r="5" fill={ACCENT} stroke="white" strokeWidth="2" />
    </svg>
  );
}

/** Receipt + chat bubble — feature: WhatsApp receipts. */
export function MessagingArt({ className }: Props) {
  return (
    <svg viewBox="0 0 160 160" fill="none" className={className} aria-hidden>
      <rect width="160" height="160" rx="20" fill={SOFT} />
      {/* phone */}
      <rect x="42" y="22" width="60" height="110" rx="10" fill="white" stroke={ACCENT} strokeWidth="3" />
      <rect x="50" y="36" width="44" height="80" rx="3" fill={TINT} />
      {/* incoming chat bubble */}
      <path
        d="M58 50 H86 a4 4 0 0 1 4 4 v12 a4 4 0 0 1 -4 4 H66 l-6 6 V54 a4 4 0 0 1 -2 -4z"
        fill="white"
        stroke={ACCENT}
        strokeWidth="2.5"
      />
      {/* outgoing bubble */}
      <path
        d="M82 80 H58 a4 4 0 0 0 -4 4 v12 a4 4 0 0 0 4 4 h22 l4 6 v-22 a4 4 0 0 0 -2 -4z"
        fill={ACCENT}
      />
      {/* receipt corner */}
      <path
        d="M105 96 H140 V148 L132 144 L124 148 L116 144 L108 148 L105 144 Z"
        fill="white"
        stroke={ACCENT}
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path d="M112 108 H134 M112 118 H128 M112 128 H134" stroke={ACCENT} strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
