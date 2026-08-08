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
   *
   * Read once rather than per element, because it is also an `IntersectionObserver`
   * `rootMargin`, which is fixed at construction. Rebuilding the observers on every
   * resize would cost more than the precision is worth; two screens of slack absorbs
   * the difference between the viewport this page opened at and the one it ends at.
   */
  const NEAR_VIEWPORT_PX = Math.max(1200, innerHeight * 2);

  /* ---------------------------------------------------------------- *
   * Geometry
   * ---------------------------------------------------------------- */

  /**
   * Every geometry question the optimizers ask, answered from the frame the browser
   * was going to lay out anyway.
   *
   * Calling `getBoundingClientRect()` from a sweep that has just written `loading`,
   * `preload` and `sizes` forces a synchronous layout, once per pass, on every page —
   * which was this script's entire measurable cost. `entry.boundingClientRect` is the
   * same number without the interleaved write-then-read, and the observer re-delivers
   * it when it changes, which is what removed the need to re-sweep the document.
   *
   * Two observers rather than one because the two jobs finish at different moments: an
   * image is done being measured as soon as it has been steered or has committed to a
   * source, while a deferral candidate is done as soon as it has a box to judge.
   */
  const rootMargin = `${NEAR_VIEWPORT_PX}px 0px`;
  const sizeObserver = new IntersectionObserver(onSized, { rootMargin });
  const deferObserver = new IntersectionObserver(onPlaced, { rootMargin });

  function watchSize(image: HTMLImageElement): void {
    if (!sizedImages.has(image)) sizeObserver.observe(image);
  }

  function watchDefer(element: Element): void {
    deferObserver.observe(element);
  }

  function onSized(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const image = entry.target;
      if (!(image instanceof HTMLImageElement)) {
        sizeObserver.unobserve(entry.target);
        continue;
      }
      if (trimSrcset(image, entry.boundingClientRect.width)) sizeObserver.unobserve(image);
    }
  }

  function onPlaced(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const rect = entry.boundingClientRect;
      // A zero-area box has not been laid out yet; treat it as unknown rather than as
      // offscreen, or a whole page of not-yet-sized images would be deferred. Stay
      // observed: the notification that arrives with a box is the one that decides.
      if (rect.width === 0 && rect.height === 0) continue;

      const target = entry.target;
      deferObserver.unobserve(target);
      // `top` alone, as it was when this read `getBoundingClientRect()` directly.
      // `isIntersecting` would also catch what is above the fold — already fetched, so
      // deferring it does nothing — and what is off to the side, which is usually a
      // carousel slide one swipe rather than one scroll away.
      if (rect.top <= NEAR_VIEWPORT_PX) continue;

      if (target instanceof HTMLMediaElement) tameMedia(target);
      else if (target instanceof HTMLImageElement || target instanceof HTMLIFrameElement) {
        lazyOffscreen(target);
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * trimSrcset
   * ---------------------------------------------------------------- */

  /**
   * Which images have already been steered.
   *
   * A `WeakSet` in the isolated world, not a `data-` attribute on the element. The flag
   * used to live in the page's own DOM, where any page could render
   * `data-byte-budget-sized="1"` on every image and switch this feature off for its
   * whole site with nothing anywhere reporting that it had happened.
   */
  const sizedImages = new WeakSet<HTMLImageElement>();

  /**
   * Rewrites `sizes` so the browser picks a candidate for the space the image
   * actually occupies, at one device pixel per CSS pixel.
   *
   * `srcset` itself is left alone. Removing candidates would be the obvious approach
   * and it is the wrong one: the page may swap `src`, the layout may change, and a
   * responsive image with its options deleted cannot recover. Setting `sizes` to the
   * measured width steers the same selection algorithm at a smaller answer, and the
   * page can still override it.
   *
   * `width` comes from an observer entry rather than a fresh rect read, and the return
   * value says whether this image has been settled or should keep being measured.
   */
  function trimSrcset(image: HTMLImageElement, width: number): boolean {
    if (sizedImages.has(image) || !image.srcset) return true;
    // Writing `sizes` re-runs source selection. On an image that has already chosen, a
    // newly selected candidate that is not in the memory cache starts a SECOND
    // transfer — so a feature whose whole point is fetching less would fetch the large
    // one and then the small one as well. Only an image that has not committed yet can
    // be steered, which in practice means the page's own `loading="lazy"` images below
    // the fold. This guard is also why there is no second full sweep on `load`.
    if (image.complete || image.currentSrc) return true;
    // Descriptor-based srcsets (`2x`) are chosen by DPR alone and ignore `sizes`.
    if (!/\d+w(?:\s*,|\s*$)/.test(image.srcset)) return true;
    const measured = Math.round(width || image.width);
    // Not laid out yet rather than invisible; keep it observed and decide later.
    if (measured <= 0) return false;
    sizedImages.add(image);
    image.sizes = `${measured}px`;
    return true;
  }

  /* ---------------------------------------------------------------- *
   * lazyOffscreen
   * ---------------------------------------------------------------- */

  function lazyOffscreen(element: HTMLImageElement | HTMLIFrameElement): void {
    if (element.loading === "lazy") return;
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

  /**
   * A `WeakMap`, so a gated element that the page later discards takes its captured
   * sources and its button with it instead of being pinned for the life of the tab.
   * Nothing iterates this; every use is a lookup by element.
   */
  const gatedMedia = new WeakMap<HTMLMediaElement, MediaGateState>();
  const allowedMedia = new WeakSet<HTMLMediaElement>();

  /** URL schemes that name something inside this document rather than something to fetch. */
  const SYNTHETIC_SRC = /^(?:blob|data|mediastream):/i;

  /**
   * Whether the element's sources are handles rather than addresses.
   *
   * `srcObject` is the same question in its other spelling, and is checked beside every
   * call to this.
   */
  function hasSyntheticSource(media: HTMLMediaElement): boolean {
    const src = media.getAttribute("src");
    if (src !== null && SYNTHETIC_SRC.test(src.trim())) return true;
    if (media.currentSrc !== "" && SYNTHETIC_SRC.test(media.currentSrc)) return true;
    for (const source of media.querySelectorAll<HTMLSourceElement>("source[src]")) {
      const value = source.getAttribute("src");
      if (value !== null && SYNTHETIC_SRC.test(value.trim())) return true;
    }
    return false;
  }

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
    // Put back only what is still missing. A player that attached its own source while
    // the gate was up owns the element now, and writing the captured string over it
    // would hand it a URL that no longer resolves to anything.
    if (media.getAttribute("src") === null) restoreAttribute(media, "src", state.src);
    for (const [source, src] of state.sources) {
      if (source.isConnected && source.getAttribute("src") === null) {
        source.setAttribute("src", src);
      }
    }
    restoreAttribute(media, "preload", state.preload);
    restoreAttribute(media, "autoplay", state.autoplay);
    state.host.remove();

    try {
      // `load()` resets the element onto the sources just restored. Skipped when the
      // page attached a MediaSource in the meantime, because there `load()` tears the
      // stream down and the player is given no way to find out.
      if (!media.srcObject && !hasSyntheticSource(media)) media.load();
      void media.play().catch(() => {
        // Autoplay policy or the page may refuse play. Sources and native controls are
        // restored, so the reader can still use the site's own play control.
      });
    } catch {
      // The media element was removed while it was being restored.
    }
  }

  function gateMedia(media: HTMLMediaElement): void {
    if (allowedMedia.has(media) || !media.paused || media.currentTime > 0) return;
    // `srcObject` and a `blob:`/`data:`/`mediastream:` `src` are one situation in two
    // spellings: a handle to an object in this document, not an address that can be
    // asked for again. Every MSE player — hls.js, dash.js, Shaka, video.js — assigns
    // `URL.createObjectURL(mediaSource)` to `video.src`, which reflects into the
    // attribute while the element is still paused at currentTime 0, so it arrives here
    // looking exactly like a gateable video. Taking the attribute away and calling
    // `load()` transitions the MediaSource to `closed`; handing the string back later
    // restores a dead handle, and "Load video" produces a permanently broken player
    // rather than a paused one. The try/catch below cannot save it, because `load()`
    // succeeds — destructively. There is nothing to hold here in any case: the transfer
    // belongs to the player's own fetches, which no page-side gate can reach.
    if (media.srcObject || hasSyntheticSource(media)) return;

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

  /**
   * Runs `fn` over `root` itself and every match beneath it.
   *
   * The incremental path passes one added element, never the document. Re-querying the
   * whole document on every mutation is what made this script cost a full-page
   * `querySelectorAll` per frame on a feed that never stops appending — and an added
   * node is not returned by its own `querySelectorAll`, which is what the `matches`
   * line is for.
   */
  function each<T extends Element>(
    root: ParentNode,
    selector: string,
    fn: (element: T) => void,
  ): void {
    if (root instanceof Element && root.matches(selector)) fn(root as T);
    for (const element of root.querySelectorAll(selector)) fn(element as T);
  }

  function apply(root: ParentNode): void {
    if (active.has("dropHints")) {
      each<HTMLLinkElement>(root, "link[rel]", dropHint);
    }
    if (active.has("trimSrcset")) {
      each<HTMLImageElement>(root, "img[srcset]", watchSize);
    }
    if (active.has("lazyOffscreen")) {
      each<HTMLImageElement | HTMLIFrameElement>(
        root,
        "img:not([loading]), iframe:not([loading])",
        watchDefer,
      );
    }
    if (active.has("clickToLoadMedia")) {
      each<HTMLMediaElement>(root, "video, audio", gateMedia);
    } else if (active.has("tameMedia")) {
      each<HTMLMediaElement>(root, "video, audio", watchDefer);
    }
  }

  function start(): void {
    if (started || active.size === 0) return;
    started = true;

    // One full-document pass, because the parser has already inserted whatever it got
    // through while the worker was answering. There is deliberately no second pass on
    // `load`: re-sweeping a finished document is how `trimSrcset` came to write `sizes`
    // on images that had already completed, which re-runs source selection and can pay
    // for the same picture twice. Layout that is not final yet belongs to the observers
    // above, not to another sweep.
    apply(document);

    // Modern apps add and retarget media after the initial parse. This runs in the
    // mutation callback rather than a batched animation frame because every one of
    // these decisions expires within a microtask or two: a `<link rel=preload>` is
    // acted on the moment it lands, an `<img srcset>` picks its candidate in the
    // microtask after insertion, and a media element left holding its source for a
    // frame has already begun fetching it. What keeps that affordable is the scope —
    // the added subtree, not the document.
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes") {
          // Only clickToLoadMedia asks for attribute records, and only for the three
          // that can hand a media element a new source.
          const target = mutation.target;
          if (target instanceof HTMLMediaElement) {
            gateMedia(target);
          } else if (target instanceof HTMLSourceElement) {
            const media = target.closest("video, audio");
            if (media instanceof HTMLMediaElement) gateMedia(media);
          }
          continue;
        }

        for (const added of mutation.addedNodes) {
          if (!(added instanceof Element)) continue;
          apply(added);
          if (active.has("clickToLoadMedia") && added instanceof HTMLSourceElement) {
            // A `<source>` appended to a media element that is already in the document:
            // the element to gate is above the added node, so no sweep rooted at the
            // added node can reach it.
            const media = added.closest("video, audio");
            if (media instanceof HTMLMediaElement) gateMedia(media);
          }
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: active.has("clickToLoadMedia"),
      attributeFilter: active.has("clickToLoadMedia") ? ["src", "preload", "autoplay"] : undefined,
    });
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
