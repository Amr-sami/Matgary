import { Image, StyleSheet, View } from "react-native";

/**
 * Port of apps/web/components/brand/Logo.tsx.
 *
 * The wordmark is a real asset, not type: "ستورو" in accent blue with the
 * diagonal-cut S mark beside it, red over blue. The source PNG is 1080×1080
 * with the mark centred and a lot of vertical whitespace, which the web crops
 * with `object-cover` inside a wide box — `resizeMode="cover"` is the same
 * thing, and the box sizes below are the web's w-40/h-10 and w-56/h-14.
 *
 * An earlier version of this file drew the mark with two clipped halves of a
 * text glyph. It rendered as a stray "ء" and looked nothing like the brand.
 * Use the asset.
 */
const BOX = {
  md: { width: 160, height: 40 },
  lg: { width: 224, height: 56 },
} as const;

interface LogoProps {
  size?: keyof typeof BOX;
  locale?: "ar" | "en";
}

export function Logo({ size = "md", locale = "ar" }: LogoProps) {
  return (
    <View style={[styles.wrap, BOX[size]]}>
      <Image
        source={
          locale === "en"
            ? require("@/assets/images/logo-en.png")
            : require("@/assets/images/logo-ar.png")
        }
        style={styles.img}
        resizeMode="cover"
        accessibilityLabel={locale === "en" ? "TheStoro" : "ستورو"}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
  img: { width: "100%", height: "100%" },
});
