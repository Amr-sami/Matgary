import { useMemo } from "react";
import { View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { isValidIpaLink } from "@matgary/domain/collections/ipa";
import { qrMatrix, qrSvgPath } from "@matgary/domain/collections/qr";

import { t } from "@/i18n";

/**
 * The shop's InstaPay QR, drawn from the stored `ipa_link` (doc 15 spec 08
 * §4.2 item 4, §4.13): one <Path> of dark-module runs on a white <Rect>,
 * with a 4-module quiet zone, black on white even in dark mode (R5), at
 * ≥ 200 pt.
 *
 * A link that fails `isValidIpaLink` is NEVER drawn (look-alike phishing
 * links, [instapay.md §7 IF7]); the panel shows the handle instead.
 *
 * UNVERIFIED (R4, doc 14 DC08-6): that the InstaPay app scans a QR of this
 * link. Checked on a real phone before the pilot; if it fails, set
 * SHOW_IPA_QR to false — the handle, holder name and WhatsApp share stay.
 */
export const SHOW_IPA_QR = true;

export function IpaQr({
  link,
  size = 220,
  testID = "pos-collection-qr",
}: {
  link: string;
  size?: number;
  testID?: string;
}) {
  const drawn = useMemo(() => {
    if (!SHOW_IPA_QR || !isValidIpaLink(link)) return null;
    try {
      return qrSvgPath(qrMatrix(link.trim()), 4);
    } catch {
      return null;
    }
  }, [link]);
  if (!drawn) return null;
  return (
    <View
      testID={testID}
      collapsable={false}
      accessible
      accessibilityRole="image"
      accessibilityLabel={t("app.collections.pos.scanHint")}
      style={{ width: size, height: size, backgroundColor: "#FFFFFF", alignSelf: "center" }}
    >
      <Svg width={size} height={size} viewBox={`0 0 ${drawn.viewBox} ${drawn.viewBox}`}>
        <Rect x={0} y={0} width={drawn.viewBox} height={drawn.viewBox} fill="#FFFFFF" />
        <Path d={drawn.d} fill="#000000" />
      </Svg>
    </View>
  );
}
