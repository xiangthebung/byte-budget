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
    // Already running: ask for the current state so a re-injection refreshes rather
    // than stacking a second banner.
    window.dispatchEvent(new CustomEvent("byte-budget-refresh"));
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

  let dismissed = false;

  function remove(): void {
    document.getElementById(HOST_ID)?.remove();
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
        margin-left: auto;
        padding: 0 5px;
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

  function render(notice: Notice): void {
    remove();
    if (dismissed || !document.body) return;

    const host = document.createElement("div");
    host.id = HOST_ID;
    // A closed shadow root, so the page's own stylesheet cannot restyle the notice
    // and the page's scripts cannot read or remove it by accident.
    const root = host.attachShadow({ mode: "closed" });

    const sheet = document.createElement("style");
    sheet.textContent = style();

    const card = document.createElement("div");
    card.className = "card";
    card.setAttribute("role", "status");

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
      dismissed = true;
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
              dismissed = true;
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

    root.append(sheet, card);
    document.body.append(host);
  }

  function refresh(): void {
    try {
      chrome.runtime.sendMessage({ type: "GET_TAB_NOTICE" }, (response) => {
        void chrome.runtime.lastError;
        const notice = (response as { ok?: boolean; notice?: Notice | null } | undefined)?.notice;
        if (notice) render(notice);
        else remove();
      });
    } catch {
      remove();
    }
  }

  window.addEventListener("byte-budget-refresh", refresh);

  // The worker pushes an update when a tier changes or a limit is lifted, so the
  // banner does not sit there claiming a limit that is no longer in force.
  chrome.runtime.onMessage.addListener((message) => {
    const payload = message as { type?: string; notice?: Notice | null };
    if (payload?.type !== "NOTICE_UPDATE") return;
    if (payload.notice) render(payload.notice);
    else remove();
  });

  if (document.body) refresh();
  else document.addEventListener("DOMContentLoaded", refresh, { once: true });
})();
