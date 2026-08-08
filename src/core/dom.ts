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
