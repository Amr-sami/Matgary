// Run: npm test -w @matgary/domain
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  IPA_HANDLE_RE,
  IPA_LINK_RE,
  ipaHandleFromLink,
  ipaLinkFromShareText,
  isValidIpaHandle,
  isValidIpaLink,
} from "../ipa";

const VALID = "https://ipn.eg/S/shop.name/instapay/AbC123";

test("a valid link and its handle", () => {
  assert.equal(isValidIpaLink(VALID), true);
  assert.equal(isValidIpaLink(`  ${VALID}\n`), true, "trimmed");
  assert.equal(ipaHandleFromLink(VALID), "shop.name@instapay");
  assert.equal(ipaHandleFromLink("https://ipn.eg/S/Shop_Name-1/instapay/Z9"), "shop_name-1@instapay", "lower-cased");
  assert.ok(IPA_LINK_RE.test(VALID));
});

test("look-alike links are rejected (IF7)", () => {
  const lookAlikes = [
    "https://ipn.eg.evil.com/S/shop/instapay/AbC123", // another host
    "https://evil.com/ipn.eg/S/shop/instapay/AbC123", // another host, path trick
    "http://ipn.eg/S/shop/instapay/AbC123", // http
    "https://ipn.eg/S/shop/instapay/AbC123?x=1", // query
    "https://ipn.eg/S/shop/instapay/AbC123#frag", // fragment
    "https://ipn.eg/S/shop/instapay/AbC123/", // trailing slash
    "https://IPN.EG/S/shop/instapay/AbC123", // upper-case host
    "https://ipn.eg/S/instapay/AbC123", // missing segment
    "https://ipn.eg/S//instapay/AbC123", // empty segment
    "https://ipn.eg/S/shop/instapay/", // no id
    "https://ipn.eg/S/shop/instapay/Ab-C123", // id not alphanumeric
    "https://ipn.eg:443/S/shop/instapay/AbC123", // port
    "https://user@ipn.eg/S/shop/instapay/AbC123", // userinfo
    "https://ipn.eg/s/shop/instapay/AbC123", // lower-case S
    "ipn.eg/S/shop/instapay/AbC123", // no scheme
    "",
  ];
  for (const link of lookAlikes) {
    assert.equal(isValidIpaLink(link), false, link);
    assert.equal(ipaHandleFromLink(link), null, link);
  }
  assert.equal(isValidIpaLink(undefined as unknown as string), false);
});

test("a percent-encoded handle segment is decoded", () => {
  assert.equal(ipaHandleFromLink("https://ipn.eg/S/ahmed%2Emohamed/instapay/AbC123"), "ahmed.mohamed@instapay");
  // A segment that decodes to something that is not a handle gives null, the link stays valid.
  assert.equal(isValidIpaLink("https://ipn.eg/S/a%20b/instapay/AbC123"), true);
  assert.equal(ipaHandleFromLink("https://ipn.eg/S/a%20b/instapay/AbC123"), null);
  // Malformed percent-encoding.
  assert.equal(ipaHandleFromLink("https://ipn.eg/S/abc%E0%A4%A/instapay/AbC123"), null);
});

test("handle regex boundaries: 3 to 60 characters before @instapay", () => {
  assert.equal(isValidIpaHandle("abc@instapay"), true);
  assert.equal(isValidIpaHandle("ab@instapay"), false);
  assert.equal(isValidIpaHandle(`${"a".repeat(60)}@instapay`), true);
  assert.equal(isValidIpaHandle(`${"a".repeat(61)}@instapay`), false);
  assert.equal(isValidIpaHandle("  Shop.Name@InstaPay "), true, "lower-cased and trimmed");
  assert.equal(isValidIpaHandle("shop@instapay.com"), false);
  assert.equal(isValidIpaHandle("sh op@instapay"), false);
  assert.ok(IPA_HANDLE_RE.test("a.b_c-9@instapay"));
  assert.equal(ipaHandleFromLink(`https://ipn.eg/S/${"a".repeat(61)}/instapay/X1`), null);
});

test("ipaLinkFromShareText finds the link in the app's share wording", () => {
  const share = `Click the link to send money to shop.name@instapay ${VALID} Powered by InstaPay`;
  assert.equal(ipaLinkFromShareText(share), VALID);
  assert.equal(ipaLinkFromShareText(`Click the link to send money to shop@instapay\n${VALID}.\nPowered by InstaPay`), VALID);
  assert.equal(ipaLinkFromShareText(`رابط الدفع: ${VALID}، شكرا`), VALID);
  assert.equal(ipaLinkFromShareText(`(${VALID})`), VALID);
  assert.equal(ipaLinkFromShareText(VALID), VALID);
});

test("ipaLinkFromShareText rejects look-alikes and embedded links", () => {
  assert.equal(ipaLinkFromShareText("send to https://ipn.eg.evil.com/S/shop/instapay/AbC123"), null);
  assert.equal(ipaLinkFromShareText("https://evil.com/?to=https://ipn.eg/S/shop/instapay/AbC123"), null);
  assert.equal(ipaLinkFromShareText("https://ipn.eg/S/shop/instapay/AbC123?amount=5"), null);
  assert.equal(ipaLinkFromShareText("no link here"), null);
  assert.equal(ipaLinkFromShareText(""), null);
  // The first VALID link wins when an invalid one comes first.
  assert.equal(ipaLinkFromShareText(`https://ipn.eg/S/x/instapay/ bad, then ${VALID}`), VALID);
});
