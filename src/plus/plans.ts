/**
 * The prices, the trial length, and how often the subscription is re-checked.
 *
 * Separate from both `gate.ts` and `tier.ts` because it is the only part of the paid
 * tier that a *surface* needs and the worker also needs: the settings page prints the
 * two prices, `gate.ts` computes the trial end from the same constant, and neither
 * should be reaching into the other to get them.
 *
 * The figures here are display and arithmetic only. What anyone is actually charged is
 * whatever the plans on extensionpay.com say — this cannot set a price, and a mismatch
 * between these strings and that dashboard is a copy bug, not an overcharge. Check both
 * when either moves.
 */

/** Shown on the Plus section. Keep in step with the plans on extensionpay.com. */
export const PRICE_MONTHLY = "CA$0.99";
export const PRICE_YEARLY = "CA$7.99";

/**
 * How long a trial runs, in days.
 *
 * ExtensionPay records when a trial started and leaves the length to the extension, so
 * this constant *is* the trial: `gate.ts` computes the end from it and passes it into
 * the display text on the confirmation page, which is what stops the page promising a
 * different number from the one the gate enforces.
 *
 * Fourteen rather than seven because of what the paid tier actually is. Most of it —
 * history, the comparison table, the export — only becomes worth anything once there is
 * something recorded to look at, and a week is roughly when the daily chart stops being
 * a novelty. A trial that expires just as the feature becomes legible is a trial that
 * sells nothing.
 */
export const TRIAL_DAYS = 14;

/**
 * How old an answer may get before the worker asks again, in ms.
 *
 * Six hours. Once a provider key exists the check is one small request, so the rate is
 * chosen to be defensible in the privacy section rather than merely convenient: four
 * times a day, on a worker already awake for other reasons. A never-connected free
 * install has no key and makes no check. Payment and trial events refresh immediately.
 */
export const PLUS_REFRESH_MS = 6 * 60 * 60 * 1000;

/**
 * How old an answer may get before the Plus section says so, in ms.
 *
 * Three days, which is twelve missed refreshes. Access is not affected — a stale
 * `plus: true` still unlocks everything, by the policy at the top of `gate.ts` — but
 * "last confirmed three days ago" is a thing a paying customer is entitled to see,
 * particularly since the most likely reason for it is that a limit they set is refusing
 * the check.
 */
export const PLUS_STALE_MS = 3 * 24 * 60 * 60 * 1000;
