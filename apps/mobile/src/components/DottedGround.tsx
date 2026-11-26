import { StyleSheet, View } from "react-native";
import Svg, { Circle, Defs, Pattern, Rect } from "react-native-svg";

import { colors } from "@/theme/tokens";

/**
 * The marketing/auth background: a quincunx dot lattice on a 20px grid, drawn in
 * the accent blue at 7% opacity (mobile-dev-docs/03-design-system.md §1).
 *
 * It is meant to be almost invisible — it reads as a faint paper tooth rather
 * than a pattern. Resist the urge to make it more legible; against white it
 * resolves to about #F4F4FE, and that is correct.
 *
 * Drawn as one SVG <Pattern> rather than a grid of Views: a 390×844 screen at a
 * 20px pitch would otherwise be ~800 mounted Views.
 */
export function DottedGround() {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Svg width="100%" height="100%">
        <Defs>
          <Pattern
            id="dots"
            x="0"
            y="0"
            width="20"
            height="20"
            patternUnits="userSpaceOnUse"
          >
            <Circle cx="2" cy="2" r="1" fill={colors.accent} fillOpacity={0.07} />
            <Circle cx="12" cy="12" r="1" fill={colors.accent} fillOpacity={0.07} />
          </Pattern>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#dots)" />
      </Svg>
    </View>
  );
}
