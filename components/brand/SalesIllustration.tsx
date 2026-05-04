/**
 * Inline SVG illustration: a phone running the POS app, surrounded by floating
 * UI elements (receipt, sales chart, success badge, currency). Used on the
 * desktop side panel of the auth pages. Pure SVG — scales crisply, theme-aware
 * via currentColor.
 */
export function SalesIllustration({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 480 480"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="مندوب يسجّل بيعاً عبر تطبيق متجري"
      className={className}
    >
      {/* Background decorative circles */}
      <circle cx="240" cy="240" r="170" fill="rgba(255,255,255,0.06)" />
      <circle cx="240" cy="240" r="120" fill="rgba(255,255,255,0.07)" />

      {/* Floating dots */}
      <g fill="rgba(255,255,255,0.45)">
        <circle cx="80" cy="100" r="4" />
        <circle cx="410" cy="120" r="3" />
        <circle cx="60" cy="320" r="3" />
        <circle cx="430" cy="350" r="4" />
        <circle cx="120" cy="420" r="3" />
        <circle cx="380" cy="60" r="3" />
      </g>

      {/* Floating receipt (top-end) */}
      <g transform="translate(330 80) rotate(8)">
        <path
          d="M0 0 h70 v100 l-7 -7 l-7 7 l-7 -7 l-7 7 l-7 -7 l-7 7 l-7 -7 l-7 7 l-7 -7 l-7 7 V0z"
          fill="white"
          opacity="0.96"
        />
        <rect x="10" y="14" width="50" height="4" rx="2" fill="#1203E3" opacity="0.85" />
        <rect x="10" y="26" width="36" height="3" rx="1.5" fill="#1203E3" opacity="0.4" />
        <rect x="10" y="36" width="50" height="3" rx="1.5" fill="#1203E3" opacity="0.4" />
        <rect x="10" y="46" width="40" height="3" rx="1.5" fill="#1203E3" opacity="0.4" />
        <rect x="10" y="60" width="50" height="3.5" rx="1.5" fill="#1203E3" opacity="0.85" />
        <text
          x="55"
          y="80"
          fontSize="10"
          fontWeight="700"
          fill="#1203E3"
          textAnchor="end"
          fontFamily="ui-sans-serif, system-ui"
        >
          240 EGP
        </text>
      </g>

      {/* Floating bar-chart card (bottom-end) */}
      <g transform="translate(70 300)">
        <rect width="86" height="64" rx="10" fill="white" opacity="0.96" />
        <rect x="12" y="12" width="22" height="3" rx="1.5" fill="#1203E3" opacity="0.7" />
        <g fill="#1203E3">
          <rect x="14" y="42" width="8" height="14" rx="1.5" />
          <rect x="28" y="34" width="8" height="22" rx="1.5" />
          <rect x="42" y="26" width="8" height="30" rx="1.5" />
          <rect x="56" y="20" width="8" height="36" rx="1.5" />
          <rect x="70" y="30" width="8" height="26" rx="1.5" />
        </g>
      </g>

      {/* Floating success badge (top-start) */}
      <g transform="translate(85 130)">
        <circle cx="0" cy="0" r="22" fill="#10B981" />
        <path
          d="M-9 0 l6 6 l12 -12"
          stroke="white"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </g>
      {/* Currency coin (bottom-start) */}
      <g transform="translate(395 360)">
        <circle cx="0" cy="0" r="22" fill="#FBBF24" />
        <text
          x="0"
          y="6"
          fontSize="20"
          fontWeight="800"
          textAnchor="middle"
          fill="#92400E"
          fontFamily="ui-sans-serif, system-ui"
        >
          ج
        </text>
      </g>

      {/* Phone — center-stage */}
      <g transform="translate(160 80)">
        {/* Soft drop shadow */}
        <rect x="6" y="14" width="160" height="290" rx="28" fill="rgba(0,0,0,0.25)" />
        {/* Phone body */}
        <rect x="0" y="0" width="160" height="290" rx="26" fill="#FFFFFF" />
        {/* Screen */}
        <rect x="8" y="14" width="144" height="262" rx="18" fill="#F8F9FF" />
        {/* Notch */}
        <rect x="60" y="6" width="40" height="6" rx="3" fill="#1A1A2E" />

        {/* App header */}
        <rect x="16" y="22" width="128" height="32" rx="8" fill="#1203E3" />
        <text
          x="80"
          y="42"
          fontSize="13"
          fontWeight="800"
          fill="white"
          textAnchor="middle"
          fontFamily="ui-sans-serif, system-ui"
        >
          متجري
        </text>

        {/* Search bar */}
        <rect x="16" y="60" width="128" height="22" rx="6" fill="#E7E6FC" />
        <circle cx="28" cy="71" r="3.5" fill="none" stroke="#1203E3" strokeWidth="1.5" />
        <line x1="30.5" y1="73.5" x2="34" y2="77" stroke="#1203E3" strokeWidth="1.5" strokeLinecap="round" />

        {/* Cart line items */}
        <g>
          <rect x="16" y="92" width="128" height="28" rx="6" fill="white" stroke="#E7E6FC" />
          <circle cx="28" cy="106" r="6" fill="#1203E3" opacity="0.15" />
          <rect x="40" y="100" width="50" height="3.5" rx="1.5" fill="#1A1A2E" />
          <rect x="40" y="108" width="30" height="3" rx="1.5" fill="#9CA3AF" />
          <text x="138" y="110" fontSize="9" fontWeight="700" fill="#1203E3" textAnchor="end" fontFamily="ui-sans-serif, system-ui">
            120
          </text>
        </g>
        <g>
          <rect x="16" y="124" width="128" height="28" rx="6" fill="white" stroke="#E7E6FC" />
          <circle cx="28" cy="138" r="6" fill="#1203E3" opacity="0.15" />
          <rect x="40" y="132" width="44" height="3.5" rx="1.5" fill="#1A1A2E" />
          <rect x="40" y="140" width="34" height="3" rx="1.5" fill="#9CA3AF" />
          <text x="138" y="142" fontSize="9" fontWeight="700" fill="#1203E3" textAnchor="end" fontFamily="ui-sans-serif, system-ui">
            80
          </text>
        </g>
        <g>
          <rect x="16" y="156" width="128" height="28" rx="6" fill="white" stroke="#E7E6FC" />
          <circle cx="28" cy="170" r="6" fill="#1203E3" opacity="0.15" />
          <rect x="40" y="164" width="38" height="3.5" rx="1.5" fill="#1A1A2E" />
          <rect x="40" y="172" width="28" height="3" rx="1.5" fill="#9CA3AF" />
          <text x="138" y="174" fontSize="9" fontWeight="700" fill="#1203E3" textAnchor="end" fontFamily="ui-sans-serif, system-ui">
            40
          </text>
        </g>

        {/* Total row */}
        <rect x="16" y="196" width="128" height="22" rx="6" fill="#E7E6FC" />
        <text x="22" y="210" fontSize="9" fontWeight="700" fill="#1203E3" fontFamily="ui-sans-serif, system-ui">
          الإجمالي
        </text>
        <text x="138" y="210" fontSize="11" fontWeight="800" fill="#1203E3" textAnchor="end" fontFamily="ui-sans-serif, system-ui">
          240 ج.م
        </text>

        {/* Action button */}
        <rect x="16" y="228" width="128" height="32" rx="10" fill="#1203E3" />
        <text x="80" y="248" fontSize="11" fontWeight="800" fill="white" textAnchor="middle" fontFamily="ui-sans-serif, system-ui">
          إتمام البيع
        </text>

        {/* Bottom indicator */}
        <rect x="64" y="270" width="32" height="3" rx="1.5" fill="#9CA3AF" opacity="0.6" />
      </g>

      {/* Hand holding the phone — subtle silhouette below */}
      <g transform="translate(140 360)" fill="rgba(255,255,255,0.95)">
        <path d="M0 30 Q20 0 60 0 H140 Q180 0 200 30 V70 H0 Z" />
        <path d="M30 30 Q40 -10 70 -8 L70 0 H50 Q40 0 30 30 Z" opacity="0.85" />
        <path d="M170 30 Q160 -10 130 -8 L130 0 H150 Q160 0 170 30 Z" opacity="0.85" />
      </g>

      {/* Spark accents */}
      <g stroke="white" strokeWidth="2.5" strokeLinecap="round" opacity="0.85">
        <line x1="40" y1="60" x2="40" y2="74" />
        <line x1="33" y1="67" x2="47" y2="67" />
      </g>
      <g stroke="white" strokeWidth="2" strokeLinecap="round" opacity="0.7">
        <line x1="440" y1="220" x2="440" y2="232" />
        <line x1="434" y1="226" x2="446" y2="226" />
      </g>
    </svg>
  );
}
