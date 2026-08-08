/** Small DOM helpers shared by the popup and the dashboard. */

export function query<T extends Element>(selector: string, root: ParentNode = document): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Markup is missing ${selector}.`);
  return element;
}

export function queryAll<T extends Element>(selector: string, root: ParentNode = document): T[] {
  return [...root.querySelectorAll<T>(selector)];
}

export interface ElementOptions {
  className?: string;
  text?: string;
  title?: string;
  ariaLabel?: string;
  ariaHidden?: boolean;
  role?: string;
  style?: Partial<Record<string, string>>;
  dataset?: Record<string, string>;
}

export type Child = Node | string | undefined | null | false;

export function element<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  options: ElementOptions = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tagName);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.title) node.title = options.title;
  if (options.role) node.setAttribute("role", options.role);
  if (options.ariaLabel) node.setAttribute("aria-label", options.ariaLabel);
  if (options.ariaHidden) node.setAttribute("aria-hidden", "true");
  for (const [key, value] of Object.entries(options.style ?? {})) {
    if (value !== undefined) node.style.setProperty(key, value);
  }
  for (const [key, value] of Object.entries(options.dataset ?? {})) {
    node.dataset[key] = value;
  }
  append(node, children);
  return node;
}

export function append(node: Node, children: Child[]): void {
  for (const child of children) {
    if (child === undefined || child === null || child === false) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
}

export function button(
  className: string,
  options: ElementOptions & { onClick?: () => void } = {},
  children: Child[] = [],
): HTMLButtonElement {
  const node = element("button", { ...options, className }, children);
  node.type = "button";
  if (options.onClick) node.addEventListener("click", options.onClick);
  return node;
}

export function replaceChildren(node: Element, children: Child[]): void {
  node.replaceChildren();
  append(node, children);
}

/* ------------------------------------------------------------------ *
 * Single-choice groups
 * ------------------------------------------------------------------ */

/**
 * The period and range pickers are radio groups, not tablists.
 *
 * `role="tab"` is a promise about a `tabpanel`: a screen reader announces "Today
 * tab, selected, 2 of 4", the user presses Left, and expects the panel to change.
 * Nothing here owns a panel — choosing a period re-renders the whole surface — and
 * the three hand-wired tablists implemented none of the keyboard contract that
 * goes with the role, so the announcement described a control that did not exist.
 * A radio group claims exactly what these do, and one implementation is the only
 * way three of them stay correct.
 */
export interface GroupOption<T extends string | number> {
  value: T;
  label: string;
  /** Replaces the visible label for a screen reader, when the label is an abbreviation. */
  ariaLabel?: string;
  title?: string;
}

export interface GroupConfig<T extends string | number> {
  container: HTMLElement;
  options: readonly GroupOption<T>[];
  /** The option to check now. Must be the surface's own state, not a guess. */
  value: T;
  onSelect: (value: T) => void;
  /** Names the group, if the container markup does not already carry an `aria-label`. */
  label?: string;
  /** Class for each option button. Both shipped containers style by descendant, so this is rarely needed. */
  optionClass?: string;
}

const OPTION_SELECTOR = "[data-option]";
const MOVEMENT_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];

/**
 * Activation per container, looked up at event time.
 *
 * The listeners go on the container once and read this map when they fire, so
 * `bindGroup` can be called again with a different option set — which is what the
 * surfaces do today on every period change — without stacking a second handler
 * that would fire `onSelect` twice per click.
 */
const groupHandlers = new WeakMap<HTMLElement, (raw: string) => void>();

/**
 * Builds the options into `container` and wires click, arrow keys, Home/End and ARIA.
 *
 * Call it once per group, not from the render path. It replaces the option
 * elements, so calling it on every change — which is what the surfaces do today —
 * destroys the button the user is standing on between one keypress and the next.
 * A re-render calls `paintGroup`.
 */
export function bindGroup<T extends string | number>(config: GroupConfig<T>): void {
  const { container, options, value, onSelect, label, optionClass } = config;

  container.setAttribute("role", "radiogroup");
  if (label !== undefined && !container.hasAttribute("aria-label")) {
    container.setAttribute("aria-label", label);
  }

  const listening = groupHandlers.has(container);
  groupHandlers.set(container, (raw) => {
    const match = options.find((option) => String(option.value) === raw);
    if (match) onSelect(match.value);
  });

  replaceChildren(
    container,
    options.map((option) => {
      const node = button(optionClass ?? "", {
        text: option.label,
        dataset: { option: String(option.value) },
        ...(option.title !== undefined ? { title: option.title } : {}),
        ...(option.ariaLabel !== undefined ? { ariaLabel: option.ariaLabel } : {}),
      });
      node.setAttribute("role", "radio");
      return node;
    }),
  );

  if (!listening) {
    container.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest<HTMLButtonElement>(OPTION_SELECTOR);
      if (target && container.contains(target)) activateOption(container, target);
    });

    container.addEventListener("keydown", (event) => {
      if (!MOVEMENT_KEYS.includes(event.key)) return;
      const nodes = queryAll<HTMLButtonElement>(OPTION_SELECTOR, container);
      const current = (event.target as HTMLElement).closest<HTMLButtonElement>(OPTION_SELECTOR);
      if (!current || nodes.length === 0 || !container.contains(current)) return;
      // Arrow keys scroll the dashboard otherwise, which moves the group off screen
      // at the same moment it takes focus.
      event.preventDefault();
      const step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
      const index = nodes.indexOf(current);
      const next =
        event.key === "Home"
          ? nodes[0]
          : event.key === "End"
            ? nodes.at(-1)
            : nodes[(index + step + nodes.length) % nodes.length];
      if (!next) return;
      next.focus();
      activateOption(container, next);
    });
  }

  paintGroup(container, value);
}

function activateOption(container: HTMLElement, node: HTMLButtonElement): void {
  const raw = node.dataset.option;
  // Re-choosing the option that is already checked would re-render the surface for
  // no change — which in the popup means destroying the focus the user just moved.
  if (raw === undefined || node.getAttribute("aria-checked") === "true") return;
  groupHandlers.get(container)?.(raw);
}

/**
 * Marks `value` as the checked option and moves the roving tabindex onto it.
 *
 * Separate from `bindGroup` because the surface, not the group, decides when a
 * choice has been accepted: paint from the same place that re-renders, so the
 * control can never show a period the rest of the page is not showing.
 */
export function paintGroup(container: HTMLElement, value: string | number): void {
  const raw = String(value);
  const nodes = queryAll<HTMLButtonElement>(OPTION_SELECTOR, container);
  let checked = false;
  for (const node of nodes) {
    const selected = node.dataset.option === raw;
    if (selected) checked = true;
    node.setAttribute("aria-checked", String(selected));
    node.tabIndex = selected ? 0 : -1;
  }
  // A roving tabindex with nothing checked is a group Tab cannot enter at all, so a
  // value matching no option still has to leave one way in.
  const first = nodes[0];
  if (!checked && first) first.tabIndex = 0;
}

/**
 * A site icon from Chrome's own favicon cache.
 *
 * `_favicon/` reads what the browser already has, so a list of forty sites costs
 * no network requests — which would be a strange thing for a data-usage tracker
 * to spend bytes on. Needs the `favicon` permission.
 */
export function faviconUrl(pageUrl: string, size = 32): string {
  const url = new URL(chrome.runtime.getURL("/_favicon/"));
  url.searchParams.set("pageUrl", pageUrl);
  url.searchParams.set("size", String(size));
  return url.toString();
}

/**
 * A stable colour per key, for the type breakdown and the site bars.
 *
 * Hashed rather than assigned from a palette in order, so a site keeps its colour
 * as the list around it reorders. Hue only: saturation and lightness come from
 * the theme so the same hash reads correctly in light and dark.
 */
export function hueFor(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index++) {
    hash = (hash * 31 + key.charCodeAt(index)) % 360_000;
  }
  return hash % 360;
}
