import { useState } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Line, Path, Text as SvgText } from "react-native-svg";

import { colors, fonts } from "@/theme/tokens";

/**
 * The sales trend line from app__insights.png.
 *
 * Hand-drawn on react-native-svg rather than pulling in victory-native: this is
 * one series with a faint grid, and Skia plus a charting layer is a large
 * dependency to carry for that. Swap it when the deep-dive screens need real
 * axes and tooltips.
 *
 * The x axis is INDEX-based, not time-based — the API returns one point per day
 * including zero-revenue days, so spacing is uniform by construction.
 */
export function TrendChart({
  data,
  height = 180,
}: {
  data: { date: string; revenue: number }[];
  height?: number;
}) {
  const [width, setWidth] = useState(0);

  if (data.length < 2 || width === 0) {
    return <View style={{ height }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)} />;
  }

  const padLeft = 44;
  const padBottom = 18;
  const padTop = 8;
  const plotW = Math.max(width - padLeft - 8, 1);
  const plotH = Math.max(height - padBottom - padTop, 1);

  const max = Math.max(...data.map((d) => d.revenue), 1);
  const x = (i: number) => padLeft + (i / (data.length - 1)) * plotW;
  const y = (v: number) => padTop + plotH - (v / max) * plotH;

  const path = data
    .map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d.revenue).toFixed(1)}`)
    .join(" ");
  const area = `${path} L${x(data.length - 1).toFixed(1)},${(padTop + plotH).toFixed(1)} L${padLeft},${(padTop + plotH).toFixed(1)} Z`;

  const ticks = [0.25, 0.5, 0.75, 1].map((f) => ({ v: max * f, y: y(max * f) }));
  const short = (v: number) =>
    v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(Math.round(v));

  return (
    <View style={styles.wrap} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <Svg width={width} height={height}>
        {ticks.map((t) => (
          <Line
            key={t.v}
            x1={padLeft}
            y1={t.y}
            x2={width - 8}
            y2={t.y}
            stroke={colors.border}
            strokeWidth={1}
            strokeDasharray="4 4"
          />
        ))}
        {ticks.map((t) => (
          <SvgText
            key={`l-${t.v}`}
            x={padLeft - 6}
            y={t.y + 4}
            fontSize={10}
            fill={colors.textSecondary}
            fontFamily={fonts.regular}
            textAnchor="end"
          >
            {short(t.v)}
          </SvgText>
        ))}
        <Path d={area} fill={colors.accent} fillOpacity={0.07} />
        <Path
          d={path}
          stroke={colors.accent}
          strokeWidth={2}
          fill="none"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  // LTR: a chart's x axis runs left-to-right even on an RTL page, because the
  // dates underneath it do.
  wrap: { width: "100%", direction: "ltr" },
});
