/**
 * The page-side optimizers: changing what a page asks for, before it asks.
 *
 * These are the ones no network rule can do, because the decision is made by the
 * browser from markup rather than expressed as a URL. A page that offers a 400px and
 * a 1600px version of the same photograph and is displaying it 380px wide will fetch
 * the 1600px one on a high-density screen; nothing about that request is
 * distinguishable from the outside.
 *
 * Registered dynamically, only while optimization is on, so a browser with the feature
 * off runs no code on any page. Which features are active arrives from the worker at
 * startup, so a changed setting applies to the next page load.
 *
 * Imports nothing, and everything is inside an IIFE behind a marker on `window`, for
 * the same reasons as the other two content scripts: manifest and `files:`-injected
 * scripts are classic scripts, and this one can be injected twice into one world.
 */

(() => {
  const MARKER = "__byteBudgetOptimize";
  const scope = window as unknown as Record<string, boolean>;
  if (scope[MARKER]) return;
  scope[MARKER] = true;

  type FeatureId =
    | "trimSrcset"
    | "lazyOffscreen"
    | "tameMedia"
    | "clickToLoadMedia"
    | "dropHints";

  let active: Set<FeatureId> = new Set();
  let started = false;

  /**
   * How far below the viewport still counts as "about to be read".
   *
   * Deferring an image the reader is one flick away from is a worse trade than the
   * bytes are worth: it arrives late and visibly. Two screens of margin means normal
   * scrolling never waits.
   */
  const NEAR_VIEWPORT_PX = () => Math.max(1200, innerHeight * 2);

  function isFarBelow(element: Element): boolean {
    const rect = element.getBoundingClientRect();
    // A zero-height element has not been laid out yet; treat it as unknown rather than
    // as offscreen, or a whole page of not-yet-sized images would be deferred.
    if (rect.height === 0 && rect.width === 0) return false;
    return rect.top > NEAR_VIEWPORT_PX();
  }

  /* ---------------------------------------------------------------- *
   * trimSrcset
   * ---------------------------------------------------------------- */

  /**
   * Rewrites `sizes` so the browser picks a candidate for the space the image
   * actually occupies, at one device pixel per CSS pixel.
   *
   * `srcset` itself is left alone. Removing candidates would be the obvious approach
   * and it is the wrong one: the page may swap `src`, the layout may change, and a
   * responsive image with its options deleted cannot recover. Setting `sizes` to the
   * measured width steers the same selection algorithm at a smaller answer, and the
   * page can still override it.
   */
  function trimSrcset(image: HTMLImageElement): void {
    if (!image.srcset || image.dataset.byteBudgetSized === "1") return;
    const width = Math.round(image.getBoundingClientRect().width || image.width);
    if (width <= 0) return;
    // Descriptor-based srcsets (`2x`) are chosen by DPR alone and ignore `sizes`.
    if (!/\d+w(?:\s*,|\s*$)/.test(image.srcset)) return;
    image.dataset.byteBudgetSized = "1";
    image.sizes = `${width}px`;
  }

  /* ---------------------------------------------------------------- *
   * lazyOffscreen
   * ---------------------------------------------------------------- */

  function lazyOffscreen(element: HTMLImageElement | HTMLIFrameElement): void {
    if (element.loading === "lazy" || !isFarBelow(element)) return;
    element.loading = "lazy";
    if (element instanceof HTMLImageElement) element.decoding = "async";
  }

  /* ---------------------------------------------------------------- *
   * tameMedia
   * ---------------------------------------------------------------- */

  /**
   * Stops offscreen video and audio pre-buffering.
   *
   * Anything already playing is left alone — interrupting media someone is watching
   * is not an optimization.
   */
  function tameMedia(media: HTMLMediaElement): void {
    if (!media.paused || media.currentTime > 0) return;
    if (!isFarBelow(media)) return;
    if (media.preload !== "none") media.preload = "none";
    if (media.autoplay) media.autoplay = false;
  }

  /* ---------------------------------------------------------------- *
   * clickToLoadMedia
   * ---------------------------------------------------------------- */

  interface MediaGateState {
    src: string | null;
    sources: Map<HTMLSourceElement, string>;
    preload: string | null;
    autoplay: string | null;
    host: HTMLSpanElement;
    onMediaClick: EventListener;
  }

  const gatedMedia = new Map<HTMLMediaElement, MediaGateState>();
  const allowedMedia = new WeakSet<HTMLMediaElement>();

  function restoreAttribute(element: Element, name: string, value: string | null): void {
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
  }

  /** Captures and removes every URL currently offered by a gated media element. */
  function holdMediaSources(media: HTMLMediaElement, state: MediaGateState): boolean {
    let changed = false;
    const src = media.getAttribute("src");
    if (src !== null) {
      state.src = src;
      media.removeAttribute("src");
      changed = true;
    }
    for (const source of media.querySelectorAll<HTMLSourceElement>("source[src]")) {
      const value = source.getAttribute("src");
      if (value === null) continue;
      state.sources.set(source, value);
      source.removeAttribute("src");
      changed = true;
    }
    return changed;
  }

  function makeLoadButton(media: HTMLMediaElement): HTMLSpanElement {
    const kind = media instanceof HTMLVideoElement ? "video" : "audio";
    const host = document.createElement("span");
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial;
        display: inline-block;
        position: relative;
        z-index: 2147483646;
        margin: 6px;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      button {
        min-height: 38px;
        padding: 8px 13px;
        border: 1px solid #b9c8cb;
        border-radius: 10px;
        background: #fff;
        color: #16262c;
        font-family: inherit;
        font-size: 13px;
        font-weight: 600;
        line-height: 1.2;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(18, 44, 48, .14);
      }
      button:hover { background: #eef4f4; }
      button:focus-visible { outline: 3px solid rgba(15, 106, 98, .35); outline-offset: 2px; }
      @media (prefers-color-scheme: dark) {
        button { border-color: #40545b; background: #162126; color: #e9f1f2; }
        button:hover { background: #22333a; }
      }
    `;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `Load ${kind}`;
    button.setAttribute("aria-label", `Load ${kind}`);
    button.addEventListener("click", (event) => releaseMedia(media, event));
    shadow.append(style, button);
    return host;
  }

  /** Restores the exact page-provided sources, then plays under the user's click. */
  function releaseMedia(media: HTMLMediaElement, event?: Event): void {
    const state = gatedMedia.get(media);
    if (!state || (event && !event.isTrusted)) return;
    event?.preventDefault();
    event?.stopImmediatePropagation();

    allowedMedia.add(media);
    gatedMedia.delete(media);
    media.removeEventListener("click", state.onMediaClick, true);
    restoreAttribute(media, "src", state.src);
    for (const [source, src] of state.sources) {
      if (source.isConnected) source.setAttribute("src", src);
    }
    restoreAttribute(media, "preload", state.preload);
    restoreAttribute(media, "autoplay", state.autoplay);
    state.host.remove();

    try {
      media.load();
      void media.play().catch(() => {
        // Autoplay policy or the page may refuse play. Sources and native controls are
        // restored, so the reader can still use the site's own play control.
      });
    } catch {
      // The media element was removed while it was being restored.
    }
  }

  function gateMedia(media: HTMLMediaElement): void {
    if (allowedMedia.has(media) || media.srcObject || !media.paused || media.currentTime > 0) return;

    const existing = gatedMedia.get(media);
    if (existing) {
      // A player may assign a new source after the first sweep. Capture it before it
      // starts a second transfer and keep the same visible Load control.
      if (holdMediaSources(media, existing)) {
        media.preload = "none";
        media.autoplay = false;
        try {
          media.load();
        } catch {
          // Detached between the observer firing and this pass.
        }
      }
      return;
    }

    if (!media.isConnected || !media.parentNode) return;
    if (!media.hasAttribute("src") && !media.querySelector("source[src]")) return;

    const host = makeLoadButton(media);
    const onMediaClick: EventListener = (event) => releaseMedia(media, event);
    const state: MediaGateState = {
      src: null,
      sources: new Map(),
      preload: media.getAttribute("preload"),
      autoplay: media.getAttribute("autoplay"),
      host,
      onMediaClick,
    };
    gatedMedia.set(media, state);
    holdMediaSources(media, state);
    media.preload = "none";
    media.autoplay = false;
    media.addEventListener("click", onMediaClick, true);
    media.insertAdjacentElement("afterend", host);
    try {
      media.load();
    } catch {
      releaseMedia(media);
    }
  }

  /* ---------------------------------------------------------------- *
   * dropHints
   * ---------------------------------------------------------------- */

  const SPECULATIVE = new Set(["prefetch", "prerender", "preload", "dns-prefetch"]);

  function dropHint(link: HTMLLinkElement): void {
    const rels = link.rel.toLowerCase().split(/\s+/).filter(Boolean);
    if (!rels.some((rel) => SPECULATIVE.has(rel))) return;
    // `modulepreload` and stylesheet preloads are what the page needs to render, not
    // speculation about where you might go next.
    if (rels.includes("modulepreload")) return;
    if (rels.includes("preload") && (link.as === "style" || link.as === "font")) return;
    link.remove();
  }

  /* ---------------------------------------------------------------- *
   * Sweeping
   * ---------------------------------------------------------------- */

  function apply(root: ParentNode): void {
    if (active.has("dropHints")) {
      for (const link of root.querySelectorAll<HTMLLinkElement>("link[rel]")) dropHint(link);
    }
    if (active.has("trimSrcset")) {
      for (const image of root.querySelectorAll<HTMLImageElement>("img[srcset]")) {
        trimSrcset(image);
      }
    }
    if (active.has("lazyOffscreen")) {
      for (const node of root.querySelectorAll<HTMLImageElement | HTMLIFrameElement>(
        "img:not([loading]), iframe:not([loading])",
      )) {
        lazyOffscreen(node);
      }
    }
    if (active.has("clickToLoadMedia")) {
      for (const media of root.querySelectorAll<HTMLMediaElement>("video, audio")) {
        gateMedia(media);
      }
    } else if (active.has("tameMedia")) {
      for (const media of root.querySelectorAll<HTMLMediaElement>("video, audio")) {
        tameMedia(media);
      }
    }
  }

  function start(): void {
    if (started || active.size === 0) return;
    started = true;

    apply(document);

    // Modern apps add and retarget media after the initial parse. Media sources are
    // held in the mutation callback so they do not get a full animation frame to
    // begin loading; the less time-sensitive optimizers still share one batched pass.
    let queued = false;
    const queueSweep = (): void => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        apply(document);
      });
    };
    const observer = new MutationObserver((mutations) => {
      let needsSweep = false;
      for (const mutation of mutations) {
        if (mutation.type === "childList") needsSweep = true;
        if (!active.has("clickToLoadMedia")) continue;

        if (mutation.type === "attributes") {
          if (mutation.target instanceof HTMLMediaElement) {
            gateMedia(mutation.target);
          } else if (mutation.target instanceof HTMLSourceElement) {
            const media = mutation.target.closest("video, audio");
            if (media instanceof HTMLMediaElement) gateMedia(media);
          }
          continue;
        }

        for (const added of mutation.addedNodes) {
          if (!(added instanceof Element)) continue;
          if (added instanceof HTMLMediaElement) gateMedia(added);
          if (added instanceof HTMLSourceElement) {
            const media = added.closest("video, audio");
            if (media instanceof HTMLMediaElement) gateMedia(media);
          }
          for (const media of added.querySelectorAll<HTMLMediaElement>("video, audio")) {
            gateMedia(media);
          }
        }
      }
      if (needsSweep) queueSweep();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: active.has("clickToLoadMedia"),
      attributeFilter: active.has("clickToLoadMedia") ? ["src", "preload", "autoplay"] : undefined,
    });

    // `srcset` and offscreen decisions depend on layout, which is not final at
    // document_start. One more pass once it is.
    addEventListener("load", () => apply(document), { once: true });
  }

  try {
    chrome.runtime.sendMessage({ type: "GET_PAGE_FEATURES" }, (response) => {
      void chrome.runtime.lastError;
      const features = (response as { features?: FeatureId[] } | undefined)?.features;
      if (!Array.isArray(features) || features.length === 0) return;
      active = new Set(features);
      if (document.documentElement) start();
      else document.addEventListener("DOMContentLoaded", start, { once: true });
    });
  } catch {
    // The extension was reloaded while this page stayed open. Do nothing rather than
    // optimizing according to settings that may no longer exist.
  }
})();
