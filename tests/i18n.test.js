import test from "node:test";
import assert from "node:assert/strict";
import { resetLocaleCache, resolveLocale, t } from "../src/openclaw/i18n.js";

test("locale defaults to English when no config or language env is set", () => {
  const originalLocale = process.env.OPENCLAW_RP_LOCALE;
  const originalLang = process.env.LANG;
  delete process.env.OPENCLAW_RP_LOCALE;
  delete process.env.LANG;

  try {
    resetLocaleCache();
    assert.equal(resolveLocale({}, {}), "en");
    assert.equal(t("session_paused"), "RP session is paused (use /rp resume to continue).");
  } finally {
    restoreEnv("OPENCLAW_RP_LOCALE", originalLocale);
    restoreEnv("LANG", originalLang);
    resetLocaleCache();
  }
});

test("locale still honors explicit Chinese config", () => {
  resetLocaleCache();
  assert.equal(resolveLocale({ locale: "zh" }, {}), "zh");
  assert.notEqual(t("session_paused"), "RP session is paused (use /rp resume to continue).");
  resetLocaleCache();
});

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
