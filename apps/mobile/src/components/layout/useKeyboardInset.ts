import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

/**
 * How much of the bottom of an Android screen the soft keyboard covers, in dp
 * (0 when it is hidden, and always 0 on iOS).
 *
 * THE BUG THIS EXISTS FOR: the app runs edge-to-edge (android/gradle.properties
 * `edgeToEdgeEnabled=true`), so `windowSoftInputMode="adjustResize"` no longer
 * shrinks the window. The IME is drawn OVER the ScrollView's lower part, and
 * the ScrollView, still full height, believes it is already scrolled to the
 * end: on the Pixel 7 the new InstaPay account form stopped ~45% short, with
 * Save under the keys and no way to reach it while typing (doc 15 T1 F1).
 * A plain height is used rather than wrapping every screen in a
 * KeyboardAvoidingView, which derives the overlap from its parent-relative
 * frame and the event's `screenY`.
 *
 * RN's keyboardDidShow `endCoordinates.height` is the IME inset MINUS the
 * system-bar inset (ReactRootView.checkForKeyboardEvents), so the covered
 * band, measured from the screen bottom, is that height plus the navigation
 * bar's inset — pass `insets.bottom` from useSafeAreaInsets.
 */
export function keyboardOverlap(keyboardHeight: number, bottomInset: number): number {
  if (!(keyboardHeight > 0)) return 0;
  return keyboardHeight + Math.max(0, bottomInset);
}

export function useKeyboardInset(bottomInset: number): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    // Android only emits the Did pair (no Will events); a height change while
    // the IME stays up (emoji panel) re-emits keyboardDidShow.
    const show = Keyboard.addListener("keyboardDidShow", (e) => setHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener("keyboardDidHide", () => setHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return keyboardOverlap(height, bottomInset);
}
