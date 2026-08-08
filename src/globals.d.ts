/**
 * Build-time constants injected by Vite's `define`.
 *
 * `__THROTTLE_BUILD__` selects the channel that declares the `debugger`
 * permission. Written as a literal so the store build tree-shakes the throttle
 * code out entirely rather than shipping a branch that can never be taken —
 * which matters for review as much as for size: the full functionality of an
 * extension has to be discernible from what it ships.
 */
declare const __THROTTLE_BUILD__: boolean;
