// Voice input for the AI Agent composer. PURE INPUT MODALITY — the audio
// becomes a transcript which is handed to the existing chat text field. No
// business logic lives here.
//
// UX contract:
//   • Idle:          mic icon in the composer row (handled by the parent).
//   • Press and hold the mic:
//       - on first use we request iOS/Android recording permission.
//       - if granted, this overlay slides up and recording starts.
//       - a live mm:ss timer + bouncing bars give the "we're listening" cue.
//       - release the mic (or tap ✓) → stop + upload + transcribe.
//       - slide the finger left to the ✕ cancel pill → drop the clip entirely.
//   • Transcribing:  the overlay shows a spinner + "بيحوّل الصوت لنص…".
//   • Done:          the overlay closes and the transcript is delivered via
//                    `onTranscript(text)` to the parent, which sets it on the
//                    draft `TextInput`. The user reviews/edits and taps Send.
//
// The overlay IS the recording surface. We never auto-send; the user owns
// the final submit.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Animated,
  Easing,
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  AudioModule,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";
import { MicrophoneIcon as Microphone } from "phosphor-react-native/src/icons/Microphone";
import { CheckIcon as Check } from "phosphor-react-native/src/icons/Check";
import { XIcon as X } from "phosphor-react-native/src/icons/X";
import { ApiError, ai } from "@matgary/api-client";

import { api } from "@/api/client";
import { getLocale, t } from "@/i18n";
import { colors, fonts, radius, spacing, MIN_TOUCH } from "@/theme/tokens";
import { RTL_TEXT } from "@/theme/rtl";

interface Props {
  disabled?: boolean;
  /** Called with the final transcript; parent sets it on the composer draft. */
  onTranscript: (text: string) => void;
}

type RecordingState = "idle" | "recording" | "transcribing";

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60)
    .toString()
    .padStart(2, "0");
  const s = (total % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

/** Map a server error code or network failure into the user-facing i18n key. */
function errorKeyFor(err: unknown): string {
  if (err instanceof ApiError) {
    const body = (err.body ?? {}) as { error?: string };
    switch (body.error) {
      case "RATE_LIMITED":
        return "mobile.voice.errorRateLimited";
      case "AUDIO_TOO_LARGE":
        return "mobile.voice.errorAudioTooLarge";
      case "AUDIO_TOO_SHORT":
        return "mobile.voice.errorAudioTooShort";
      case "NO_PROVIDER_KEY":
        return "mobile.voice.errorNoServiceKey";
      case "EMPTY_TRANSCRIPT":
        return "mobile.voice.errorEmptyTranscript";
      default:
        if (err.kind === "offline" || err.kind === "timeout")
          return "mobile.voice.errorNoNetwork";
        return "mobile.voice.errorGeneric";
    }
  }
  return "mobile.voice.errorGeneric";
}

export function VoiceRecorder({ disabled, onTranscript }: Props) {
  const [state, setState] = useState<RecordingState>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // RecordingPresets.HIGH_QUALITY writes a .m4a (AAC in mp4 container) on iOS
  // and Android — one format for both, matches what Gemini accepts.
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  // Bouncing bars animation (visual "we're listening" cue). Cheap — one
  // looped Animated value, 3 bars read interpolations of it.
  const barsAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (state !== "recording") {
      barsAnim.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(barsAnim, {
          toValue: 1,
          duration: 500,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(barsAnim, {
          toValue: 0,
          duration: 500,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [state, barsAnim]);

  // "Transcribing" loader — three dots pulsing in staggered phase. Three
  // Animated values so each dot peaks at its own moment (the classic
  // thinking/typing indicator). Only runs while transcribing.
  const dotsAnim = useRef([
    new Animated.Value(0),
    new Animated.Value(0),
    new Animated.Value(0),
  ]).current;
  useEffect(() => {
    if (state !== "transcribing") {
      dotsAnim.forEach((v) => v.setValue(0));
      return;
    }
    const DURATION = 480;
    const STAGGER = 140;
    const loops = dotsAnim.map((value, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * STAGGER),
          Animated.timing(value, {
            toValue: 1,
            duration: DURATION,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(value, {
            toValue: 0,
            duration: DURATION,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.delay(DURATION * 1.5 - i * STAGGER),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [state, dotsAnim]);

  const stopTimer = useCallback(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    startedAtRef.current = null;
    setElapsedMs(0);
  }, []);

  /** Full teardown — called on cancel, success, and unmount. */
  const cleanup = useCallback(async () => {
    stopTimer();
    try {
      // Stop ignores if nothing is recording; swallow errors defensively.
      if (recorder.isRecording) await recorder.stop();
    } catch {
      /* no-op */
    }
  }, [recorder, stopTimer]);

  useEffect(() => () => void cleanup(), [cleanup]);

  const openPermissionAlert = useCallback(() => {
    Alert.alert(
      t("mobile.voice.permissionTitle"),
      t("mobile.voice.permissionBody"),
      [
        { text: t("mobile.voice.permissionCancel"), style: "cancel" },
        {
          text: t("mobile.voice.permissionOpenSettings"),
          onPress: () => {
            void Linking.openSettings();
          },
        },
      ],
    );
  }, []);

  const startRecording = useCallback(async () => {
    if (disabled || state !== "idle") return;
    setErrorMsg(null);

    // 1. Permission gate. requestRecordingPermissionsAsync is idempotent —
    //    returns the current status without prompting if already decided.
    let status = await AudioModule.getRecordingPermissionsAsync();
    if (status.status === "undetermined") {
      status = await requestRecordingPermissionsAsync();
    }
    if (!status.granted) {
      openPermissionAlert();
      return;
    }

    // 2. iOS: switch the audio session so the mic actually opens even if
    //    some other audio is playing. Android is a no-op for this flag.
    try {
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
    } catch {
      /* non-fatal — the recorder itself will error if the session is wrong */
    }

    // 3. Start.
    try {
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch (err) {
      setErrorMsg(t("mobile.voice.errorGeneric"));
      return;
    }

    startedAtRef.current = Date.now();
    tickRef.current = setInterval(() => {
      if (!startedAtRef.current) return;
      setElapsedMs(Date.now() - startedAtRef.current);
    }, 200);
    setState("recording");
  }, [disabled, state, openPermissionAlert, recorder]);

  const cancelRecording = useCallback(async () => {
    await cleanup();
    setState("idle");
    setErrorMsg(null);
  }, [cleanup]);

  const finishRecording = useCallback(async () => {
    if (state !== "recording") return;
    const durationMs = startedAtRef.current ? Date.now() - startedAtRef.current : 0;
    stopTimer();

    // Minimum 300ms — anything shorter is almost certainly a fat-finger tap.
    if (durationMs < 300) {
      await cleanup();
      setState("idle");
      setErrorMsg(t("mobile.voice.errorAudioTooShort"));
      return;
    }

    try {
      await recorder.stop();
    } catch {
      /* fall through to read the file anyway if it exists */
    }
    const uri = recorder.uri;
    if (!uri) {
      setState("idle");
      setErrorMsg(t("mobile.voice.errorGeneric"));
      return;
    }

    setState("transcribing");

    let audioBase64: string;
    try {
      audioBase64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
    } catch {
      setState("idle");
      setErrorMsg(t("mobile.voice.errorGeneric"));
      return;
    }

    try {
      const res = await ai.transcribe(api, {
        audioBase64,
        mimeType: "audio/m4a",
        durationMs,
        languageHint: getLocale() === "en" ? "en" : "ar",
      });
      // Hand the raw transcript to the parent. It owns the composer.
      onTranscript(res.text);
      setState("idle");
    } catch (err) {
      setState("idle");
      setErrorMsg(t(errorKeyFor(err)));
    } finally {
      // Delete the local file; audio has been handed off.
      try {
        await FileSystem.deleteAsync(uri, { idempotent: true });
      } catch {
        /* non-fatal */
      }
    }
  }, [state, recorder, cleanup, stopTimer, onTranscript]);

  // Bars: scale-Y interpolations off the single `barsAnim` value, each with
  // its own offset so they don't move in unison.
  const barScales = [0, 0.33, 0.66].map((offset) =>
    barsAnim.interpolate({
      inputRange: [0, 0.5, 1],
      outputRange: [0.4 + offset * 0.3, 1 + offset * 0.4, 0.4 + offset * 0.3],
    }),
  );

  return (
    <>
      <Pressable
        onPress={startRecording}
        disabled={disabled || state !== "idle"}
        accessibilityRole="button"
        accessibilityLabel={t("mobile.voice.micLabel")}
        style={({ pressed }) => [
          styles.micBtn,
          (disabled || state !== "idle") && styles.micBtnDisabled,
          pressed && styles.micBtnPressed,
        ]}
        hitSlop={8}
      >
        <Microphone size={24} color={colors.accent} weight="fill" />
      </Pressable>

      {/* Inline error hint under the composer (parent renders chat above). */}
      {errorMsg ? (
        <View style={styles.errorBanner} accessibilityLiveRegion="polite">
          <Text style={styles.errorBannerText}>{errorMsg}</Text>
        </View>
      ) : null}

      <Modal
        visible={state !== "idle"}
        transparent
        animationType="fade"
        onRequestClose={cancelRecording}
        statusBarTranslucent
      >
        <Pressable style={styles.backdrop} onPress={cancelRecording}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            {state === "recording" ? (
              <>
                <Text style={styles.sheetTitle}>
                  {t("mobile.voice.recording")}
                </Text>
                <Text style={styles.timer}>{formatDuration(elapsedMs)}</Text>

                <View style={styles.bars} accessibilityElementsHidden>
                  {barScales.map((scale, i) => (
                    <Animated.View
                      key={i}
                      style={[styles.bar, { transform: [{ scaleY: scale }] }]}
                    />
                  ))}
                </View>

                <View style={styles.actionsRow}>
                  <Pressable
                    onPress={cancelRecording}
                    accessibilityRole="button"
                    accessibilityLabel={t("mobile.voice.cancel")}
                    style={({ pressed }) => [styles.cancelBtn, pressed && styles.btnPressed]}
                  >
                    <X size={22} color={colors.danger} />
                    <Text style={styles.cancelText}>{t("mobile.voice.cancel")}</Text>
                  </Pressable>
                  <Pressable
                    onPress={finishRecording}
                    accessibilityRole="button"
                    accessibilityLabel={t("mobile.voice.stop")}
                    style={({ pressed }) => [styles.stopBtn, pressed && styles.btnPressed]}
                  >
                    <Check size={22} color={colors.onAccent} />
                    <Text style={styles.stopText}>{t("mobile.voice.stop")}</Text>
                  </Pressable>
                </View>
              </>
            ) : (
              <>
                {/* Three pulsing dots — classic clean "thinking" loader.
                    Each dot has its own staggered Animated value so the
                    wave reads left→right smoothly. Scale + opacity together
                    so the peak dot pops without the others fading away. */}
                <View style={styles.transcribingDots} accessibilityElementsHidden>
                  {dotsAnim.map((value, i) => (
                    <Animated.View
                      key={i}
                      style={[
                        styles.dot,
                        {
                          transform: [
                            {
                              scale: value.interpolate({
                                inputRange: [0, 1],
                                outputRange: [0.75, 1.25],
                              }),
                            },
                          ],
                          opacity: value.interpolate({
                            inputRange: [0, 1],
                            outputRange: [0.35, 1],
                          }),
                        },
                      ]}
                    />
                  ))}
                </View>
                <Text style={styles.sheetTitle}>
                  {t("mobile.voice.transcribing")}
                </Text>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  micBtn: {
    height: MIN_TOUCH,
    width: MIN_TOUCH,
    borderRadius: MIN_TOUCH / 2,
    justifyContent: "center",
    alignItems: "center",
    // Icon-only button — no background. Pressed state uses a subtle tint
    // so the touch still feels responsive.
    backgroundColor: "transparent",
  },
  micBtnDisabled: { opacity: 0.4 },
  micBtnPressed: { backgroundColor: colors.accentLight },
  errorBanner: {
    position: "absolute",
    bottom: 72,
    left: spacing.lg,
    right: spacing.lg,
    backgroundColor: colors.dangerLight,
    borderRadius: radius.md,
    padding: spacing.sm,
  },
  errorBannerText: {
    fontFamily: fonts.medium,
    fontSize: 12,
    color: colors.danger,
    textAlign: "center",
    ...RTL_TEXT,
  },
  backdrop: {
    flex: 1,
    backgroundColor: colors.scrim,
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.xl,
    paddingBottom: spacing.xxl,
    alignItems: "center",
    gap: spacing.lg,
  },
  sheetTitle: {
    fontFamily: fonts.bold,
    fontSize: 16,
    color: colors.text,
    ...RTL_TEXT,
  },
  timer: {
    fontFamily: fonts.bold,
    fontSize: 32,
    color: colors.accent,
    fontVariant: ["tabular-nums"],
  },
  bars: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    height: 54,
  },
  bar: {
    width: 6,
    height: 40,
    borderRadius: 3,
    backgroundColor: colors.accent,
  },
  transcribingDots: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    height: 32,
    marginBottom: spacing.sm,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.accent,
  },
  actionsRow: {
    flexDirection: "row",
    gap: spacing.lg,
    marginTop: spacing.md,
  },
  cancelBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: colors.dangerLight,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.full,
  },
  cancelText: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.danger,
  },
  stopBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.full,
  },
  stopText: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.onAccent,
  },
  btnPressed: { opacity: 0.85 },
});
