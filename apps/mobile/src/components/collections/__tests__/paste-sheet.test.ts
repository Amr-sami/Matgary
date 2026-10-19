/**
 * Run:  node --test --experimental-strip-types apps/mobile/src/components/collections/__tests__/paste-sheet.test.ts
 *
 * Audit T1 I5 (iOS): with the multi-line paste text focused, the keyboard
 * covered the account picker below it, and tapping the sheet header did not
 * put the keyboard away. The node test runner cannot render React Native, so
 * this pins the three source-level guarantees instead:
 *   1. PasteSheet renders the account picker BEFORE the text field;
 *   2. Sheet's header is a Pressable whose press dismisses the keyboard;
 *   3. the focused text is scrolled into view (picker above it can push it
 *      below the keyboard-shrunk body — seen on the iPhone with 4 accounts).
 */
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PASTE = readFileSync(join(here, "../PasteSheet.tsx"), "utf8");
const SHEET = readFileSync(join(here, "../../ui/Sheet.tsx"), "utf8");

test("I5: the account picker comes before the multi-line text in the paste sheet", () => {
  const picker = PASTE.indexOf('testIDPrefix="credits-paste-account-"');
  const text = PASTE.indexOf('testID="credits-paste-text"');
  assert.ok(picker > 0, "picker present");
  assert.ok(text > 0, "text field present");
  assert.ok(picker < text, "picker must render above the text field");
});

test("I5: a tap on the sheet header dismisses the keyboard", () => {
  assert.match(SHEET, /import \{[^}]*\bKeyboard\b[^}]*\} from "react-native"/);
  // The header container itself is the Pressable (not a View) and its press is Keyboard.dismiss.
  assert.match(
    SHEET,
    /<Pressable\s+onPress=\{Keyboard\.dismiss\}\s+accessible=\{false\}\s+testID=\{testID \? `\$\{testID\}-header` : undefined\}\s+style=\{\[styles\.header,/,
  );
});

test("I5: the focused paste text is scrolled into view above the keyboard", () => {
  assert.match(SHEET, /<ScrollView\s+ref=\{scrollRef\}/);
  assert.match(PASTE, /scrollRef=\{scrollRef\}/);
  assert.match(PASTE, /Keyboard\.addListener\("keyboardDidShow"/);
  assert.match(PASTE, /onFocus=\{\(\) => \{\s+textFocused\.current = true;\s+showText\(\);/);
  assert.match(PASTE, /scrollToEnd\(\{ animated: true \}\)/);
});
