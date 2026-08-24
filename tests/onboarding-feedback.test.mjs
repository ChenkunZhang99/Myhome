import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("new-household guidance is contextual, dismissible per household, and remains reopenable", async () => {
  const [page, guide] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/OnboardingGuide.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /const newHousehold = showingDemo && inventoryReady/);
  assert.match(page, /hsp\.onboarding\.\$\{household\.householdId\}/);
  assert.match(page, /hsp\.onboarding\.\$\{guideHouseholdId\}/);
  assert.match(page, /setGuideOpen\(true\).*查看新手指南/s);
  assert.match(guide, /onAdd/);
  assert.match(guide, /onReceipt/);
  assert.match(guide, /onStores/);
  assert.match(guide, /onSettings/);
  assert.match(guide, /不用一次录完整个家/);
});

test("feedback entry points use public privacy-aware GitHub forms", async () => {
  const [page, settings, links, bug, feature] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/SettingsPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/feedback.ts", import.meta.url), "utf8"),
    readFile(new URL("../.github/ISSUE_TEMPLATE/bug_report.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/ISSUE_TEMPLATE/feature_request.yml", import.meta.url), "utf8"),
  ]);

  assert.match(page, /FEEDBACK_HUB_URL/);
  assert.match(page, /onClick=\{\(\) => setSettingsOpen\(true\)\}/);
  assert.match(settings, /BUG_REPORT_URL/);
  assert.match(settings, /FEATURE_REQUEST_URL/);
  assert.match(settings, /反馈是公开的/);
  assert.match(links, /issues\/new\/choose/);
  assert.match(links, /bug_report\.yml/);
  assert.match(links, /feature_request\.yml/);
  for (const template of [bug, feature]) {
    assert.match(template, /隐私/);
    assert.match(template, /required: true/);
    assert.match(template, /API 密钥/);
  }
});
