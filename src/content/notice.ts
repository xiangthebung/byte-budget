/**
 * The in-page notice shown while a site is being limited.
 *
 * Without it, a limit reads as a bug. A video that refuses to play and an image
 * that never appears look exactly like a broken website, and the person who set the
 * limit is the least likely to remember they did. So the page says so, on the page,
 * where the breakage is.
 *
 * Injected on demand by the worker rather than declared in the manifest — there is
 * no reason to run code on every page in the browser to serve the handful that are
 * over a budget.
 *
 * The card is not the live region. The region is a wrapper that stays in the tree
 * while a notice is on screen; the card is swapped into it on the *next* frame,
 * because a live region only announces content that changes after it is already in
 * the document. The first version assembled a populated card and then appended it,
 * which is silent to every screen reader — so the one mechanism separating "a limit
 * I set" from "a broken website" reached everyone except the users with no other
 * signal that anything happened.
 *
 * Two constraints, same as `timing.ts`: it imports nothing, because a manifest or
 * `files:`-injected content script is a classic script and a bundle with an `import`
 * silently does nothing on a page; and everything is inside an IIFE behind a marker,
 * because it can be injected more than once into the same world.
 */

(() => {
  const MARKER = "__byteBudgetNotice";
  const HOST_ID = "byte-budget-notice";
  const scope = window as unknown as Record<string, boolean>;
  if (scope[MARKER]) {
    // Already running, and there is nothing to ask for: `announce()` follows every
    // injection with a NOTICE_UPDATE, so the live copy is about to be handed the
    // current state through the ordinary path. This used to dispatch a window event
    // that `refresh()` listened for, which meant the page's own main world could
    // fire it — so a site the user is over budget on could drive GET_TAB_NOTICE in a
    // loop, each message waking the service worker and rebuilding this shadow DOM.
    return;
  }
  scope[MARKER] = true;

  interface Notice {
    site: string;
    tier: string;
    headline: string;
    detail: string;
    canPause: boolean;
  }

  /**
   * Mirrors `TIERS` in src/limit/tiers.ts, lightest first. Copied rather than
   * imported because this file imports nothing. A tier added there and not here
   * lands at -1 below and counts as an escalation, which costs one banner too many
   * rather than silently swallowing the escalation that matters.
   */
  const TIER_ORDER = ["off", "trim", "lean", "strict"];

  /** The tier whose banner the user waved away; null while nothing is suppressed. */
  let dismissedTier: string | null = null;
  /** The live region. Survives re-renders — see `render`. */
  let region: HTMLElement | null = null;
  /** Pending fill, so two updates inside one frame produce one announcement. */
  let frame = 0;
  /** What the region is showing, so an unchanged notice is not announced twice. */
  let shown: string | null = null;

  function keyOf(notice: Notice): string {
    return [
      notice.site,
      notice.tier,
      notice.headline,
      notice.detail,
      String(notice.canPause),
    ].join(" ");
  }

  /** Whether a tier is heavier than the one the user dismissed. */
  function escalates(tier: string): boolean {
    if (dismissedTier === null) return true;
    const next = TIER_ORDER.indexOf(tier);
    return next < 0 || next > TIER_ORDER.indexOf(dismissedTier);
  }

  function cancelFill(): void {
    if (frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  }

  /** Takes the banner off the page entirely: the limit is gone, or we are. */
  function remove(): void {
    cancelFill();
    document.getElementById(HOST_ID)?.remove();
    region = null;
    shown = null;
  }

  /**
   * The limit is off. A dismissal of it stops applying with it — if the site crosses
   * again tomorrow, the user is owed the explanation again.
   */
  function withdraw(): void {
    dismissedTier = null;
    remove();
  }

  function style(): string {
    return `
      :host { all: initial; }
      .card {
        position: fixed;
        z-index: 2147483000;
        top: 12px;
        right: 12px;
        max-width: 320px;
        padding: 12px 14px;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 12px;
        background: #12262b;
        box-shadow: 0 10px 34px rgba(0, 0, 0, 0.34);
        color: #e9f1f2;
        font: 500 13px/1.45 Inter, ui-sans-serif, system-ui, "Segoe UI", sans-serif;
      }
      .row { display: flex; align-items: flex-start; gap: 10px; }
      .dot {
        flex: 0 0 auto;
        width: 8px;
        height: 8px;
        margin-top: 5px;
        border-radius: 999px;
        background: #e0a057;
      }
      .headline { font-weight: 650; }
      .detail { margin-top: 3px; color: #b6c7cb; font-size: 12px; font-weight: 400; }
      .actions { display: flex; gap: 8px; margin-top: 10px; }
      button {
        padding: 5px 9px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 7px;
        background: transparent;
        color: #d7e5e7;
        font: 600 12px/1 inherit;
        cursor: pointer;
      }
      button:hover { border-color: rgba(255, 255, 255, 0.4); color: #fff; }
      .close {
        /* 28px of target, not the ~15px the glyph occupies. This is the only undo
           for a banner that lands on arbitrary third-party pages, where a touch user
           has no alternative route to it, and the neighbouring copy rules out the
           SC 2.5.8 spacing exception. Negative margins keep the x optically where it
           was, so the card does not grow to pay for the hit area. */
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 28px;
        min-height: 28px;
        margin: -6px -6px 0 auto;
        padding: 0;
        border: 0;
        color: #8ea1a8;
        font-size: 15px;
        line-height: 1;
      }
      @media (prefers-reduced-motion: no-preference) {
        .card { animation: rise 180ms ease-out both; }
        @keyframes rise {
          from { opacity: 0; transform: translateY(-6px); }
          to { opacity: 1; transform: none; }
        }
      }
    `;
  }

  /**
   * The live region, attached empty. Nothing here reads the notice: whatever the
   * region ends up saying has to arrive after it is in the tree.
   */
  function mount(): HTMLElement | null {
    if (region?.isConnected) return region;
    if (!document.body) return null;
    document.getElementById(HOST_ID)?.remove();

    const host = document.createElement("div");
    host.id = HOST_ID;
    // A closed shadow root, so the page's own stylesheet cannot restyle the notice
    // and the page's scripts cannot read or remove it by accident.
    const root = host.attachShadow({ mode: "closed" });

    const sheet = document.createElement("style");
    sheet.textContent = style();

    const live = document.createElement("div");
    live.setAttribute("role", "status");
    live.setAttribute("aria-live", "polite");

    root.append(sheet, live);
    document.body.append(host);
    region = live;
    return live;
  }

  function build(notice: Notice): HTMLElement {
    const card = document.createElement("div");
    card.className = "card";

    const row = document.createElement("div");
    row.className = "row";

    const dot = document.createElement("span");
    dot.className = "dot";

    const copy = document.createElement("div");
    const headline = document.createElement("div");
    headline.className = "headline";
    headline.textContent = notice.headline;
    const detail = document.createElement("div");
    detail.className = "detail";
    detail.textContent = notice.detail;
    copy.append(headline, detail);

    const close = document.createElement("button");
    close.className = "close";
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "\u00d7";
    close.addEventListener("click", () => {
      // Remember *which* tier was dismissed, not merely that something was. A flat
      // flag meant waving away the `trim` banner also silenced `strict` — the tier
      // where every subresource is refused, the page is genuinely broken, and a
      // long-lived tab needs the explanation more than it ever did at `trim`.
      dismissedTier = notice.tier;
      remove();
    });

    row.append(dot, copy, close);
    card.append(row);

    if (notice.canPause) {
      const actions = document.createElement("div");
      actions.className = "actions";

      const pause = document.createElement("button");
      pause.type = "button";
      pause.textContent = "Pause for an hour";
      pause.addEventListener("click", () => {
        try {
          chrome.runtime.sendMessage(
            { type: "SNOOZE_BUDGET", site: notice.site, minutes: 60 },
            () => {
              void chrome.runtime.lastError;
              remove();
              location.reload();
            },
          );
        } catch {
          remove();
        }
      });

      const settings = document.createElement("button");
      settings.type = "button";
      settings.textContent = "Limits";
      settings.addEventListener("click", () => {
        try {
          chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" }, () => {
            void chrome.runtime.lastError;
          });
        } catch {
          // Extension reloaded underneath the page.
        }
      });

      actions.append(pause, settings);
      card.append(actions);
    }

    return card;
  }

  function render(notice: Notice): void {
    if (!escalates(notice.tier)) return;

    const key = keyOf(notice);
    // The worker re-announces on every tier sync. Re-rendering identical words would
    // repeat them to a screen reader and restart the entrance animation for everyone
    // else, so the same notice twice is a no-op.
    if (key === shown && region?.isConnected) return;

    const live = mount();
    if (!live) return;
    shown = key;

    // Empty it, then fill it a frame later. Both halves matter: the region has to be
    // in the document before its contents change, and it has to *stay* in the
    // document between the old card and the new one — tearing the host down and
    // putting a populated one back is exactly the sequence a live region ignores,
    // which would leave a tier escalation unannounced on a page the user is already
    // sitting on. A hidden tab runs no frames, so the card lands there when the tab
    // is next looked at — which is also the only moment an announcement could reach
    // anyone, so do not "fix" that with a timeout.
    cancelFill();
    live.replaceChildren();
    frame = requestAnimationFrame(() => {
      frame = 0;
      live.append(build(notice));
    });
  }

  function refresh(): void {
    try {
      chrome.runtime.sendMessage({ type: "GET_TAB_NOTICE" }, (response) => {
        void chrome.runtime.lastError;
        const notice = (response as { ok?: boolean; notice?: Notice | null } | undefined)?.notice;
        if (notice) render(notice);
        else withdraw();
      });
    } catch {
      remove();
    }
  }

  // The worker pushes an update when a tier changes or a limit is lifted, so the
  // banner does not sit there claiming a limit that is no longer in force.
  chrome.runtime.onMessage.addListener((message) => {
    const payload = message as { type?: string; notice?: Notice | null };
    if (payload?.type !== "NOTICE_UPDATE") return;
    if (payload.notice) render(payload.notice);
    else withdraw();
  });

  if (document.body) refresh();
  else document.addEventListener("DOMContentLoaded", refresh, { once: true });
})();
