/**
 * The one lock notice, and the one way to disable a locked block.
 *
 * Shared by the settings page and the dashboard because there are two surfaces with
 * ceilings on them and one product: a lock that looked one way in settings and another
 * on the dashboard would read as two different restrictions rather than one tier.
 *
 * It builds DOM and nothing else — no state, no subscription check, no idea what is
 * locked or why. `PlusStatus` is decided in the worker (`plus/gate.ts`) and applied by
 * each surface's own `renderLocks`; this file is what those two call to say so.
 */

import { element, lockGlyph, queryAll } from "../core/dom";
import { t } from "../core/i18n";

/**
 * The notice that stands in front of a locked block.
 *
 * `href` differs by surface — `#plus` inside the settings page, `settings.html#plus`
 * from the dashboard — so it is a parameter rather than a constant. An anchor rather
 * than a button for the same reason the settings rail items are anchors: Back works,
 * the browser handles the keyboard, and the destination is a real address.
 *
 * Deliberately built *outside* whatever container `setControlsEnabled` disables, and
 * every caller inserts it into a slot of its own. It is the one control in a locked
 * block that must still work, because it is the way out of it.
 */
export function lockNotice(note: string, href: string): HTMLElement {
  const link = element("a", {
    className: "ghost-button plus-lock-link",
    text: t("settingsPlusUnlock"),
  });
  link.href = href;
  return element("div", { className: "plus-lock" }, [
    lockGlyph("plus-lock-icon"),
    element("p", { className: "plus-lock-copy", text: note }),
    link,
  ]);
}

/**
 * Disables every control inside a block, and marks the container for the stylesheet.
 *
 * `disabled` rather than `pointer-events: none`, and the difference is the whole of
 * whether this is a lock. The CSS shortcut stops a mouse and does nothing to a
 * keyboard: a control that cannot be clicked but can still be reached with Tab and
 * fired with Space is not restricted, it is merely hard to find. The `data-locked`
 * attribute the stylesheet reads only dims things.
 */
export function setControlsEnabled(container: HTMLElement, enabled: boolean): void {
  for (const node of queryAll<HTMLInputElement>("input, button, select, textarea", container)) {
    node.disabled = !enabled;
  }
  container.dataset.locked = String(!enabled);
}
