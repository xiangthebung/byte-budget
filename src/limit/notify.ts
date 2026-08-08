/**
 * Telling the page it is being limited.
 *
 * The one thing that separates "a limit I set" from "a broken website" is the page
 * saying so. A refused video segment makes a player error; a refused image leaves a
 * gap. Neither looks like a decision, and the person who set the limit a fortnight
 * ago is the least likely to connect the two.
 *
 * The wording is composed here rather than in the content script, which has to stay
 * import-free — duplicating byte formatting into it would be the first thing to
 * drift out of step with the rest of the UI.
 */

import { formatAgo, formatBytes } from "../core/format";
import type { BudgetStatus, TabNotice } from "../core/messages";
import { runtimeFile } from "../core/runtime";
import type { Settings } from "../core/types";
import { BUDGET_PERIOD_LABELS } from "./budgets";

const HEADLINES: Record<string, (site: string) => string> = {
  trim: (site) => `Video and audio are being skipped on ${site}`,
  lean: (site) => `Images and video are being skipped on ${site}`,
  strict: (site) => `${site} has used up its data limit`,
};

export function noticeFor(
  status: BudgetStatus,
  units: Settings["units"],
): TabNotice | null {
  if (status.tier === "off") return null;
  const headline = HEADLINES[status.tier]?.(status.budget.site);
  if (!headline) return null;

  const spent = `${formatBytes(status.used, units)} of ${formatBytes(status.allowance, units)} ${
    BUDGET_PERIOD_LABELS[status.budget.period]
  }`;
  const resets = status.resetsAt
    ? `Resets ${formatAgo(status.resetsAt)}.`
    : "Resets when you close the browser.";

  return {
    site: status.budget.site,
    tier: status.tier,
    headline,
    detail: `${spent}. ${resets}`,
    canPause: !status.snoozed,
  };
}

async function push(tabId: number, notice: TabNotice | null): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "NOTICE_UPDATE", notice });
    return true;
  } catch {
    // No banner script in that tab yet, or the tab is gone.
    return false;
  }
}

/**
 * Shows or updates the banner in every tab showing the site.
 *
 * Tries to talk to an existing banner first and only injects when there is nobody
 * listening. Injecting unconditionally would work — the script is idempotent — but
 * it would also mean running `executeScript` on every threshold crossing of every
 * limited site, which is a lot of noise for a banner that is already on screen.
 *
 * A successful injection is followed by a second `push`, so a freshly injected
 * script and a long-lived one are told the state the same way. The banner used to
 * pull it instead, off a `window` event that the *page* could dispatch — which let
 * any site the user was over budget on drive GET_TAB_NOTICE in a loop.
 */
export async function announce(
  tabIds: readonly number[],
  notice: TabNotice | null,
): Promise<void> {
  await Promise.all(
    tabIds.map(async (tabId) => {
      if (await push(tabId, notice)) return;
      if (!notice) return; // Nothing to remove, and nothing worth injecting to say so.
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: [runtimeFile("notice.js")],
        });
        await push(tabId, notice);
      } catch {
        // A restricted origin, or the tab navigated away mid-flight. The limit is
        // still enforced; only the explanation is missing.
      }
    }),
  );
}
