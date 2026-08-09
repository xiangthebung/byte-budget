/**
 * One `allow` rule, so a limit cannot refuse the subscription check.
 *
 * ## The failure this exists to prevent
 *
 * The limit over Everything installs a rule with no `initiatorDomains` and no `tabIds`
 * — an unscoped condition, which is deliberate and is the only way a data plan can
 * reach traffic that has no site of its own (`limit/rules.ts`). At the `strict` tier
 * that rule refuses every resource type except `main_frame`.
 *
 * Two things then break for someone who is over their plan:
 *
 * 1. **The check itself.** `plus/gate.ts` fetches extensionpay.com from the worker.
 *    Whether Chrome exempts an extension's own requests from its own DNR rules is not
 *    something this codebase should be resting a paid tier on, so it is made explicit
 *    here rather than assumed. The cost of assuming wrong is a paying customer being
 *    quietly demoted to free the moment they hit the limit they are paying to manage —
 *    which is both the worst possible timing and completely invisible, since the gate
 *    fails open and simply keeps serving a staler and staler answer.
 *
 * 2. **The payment page.** That one is not theoretical at all. `main_frame` is never
 *    blocked, so extensionpay.com's document loads and its stylesheet, scripts and
 *    images do not. The person gets a white page with some unstyled text on it at the
 *    exact moment they were trying to give us money.
 *
 * ## Why a rule rather than an exclusion
 *
 * The alternative was `excludedRequestDomains: ["extensionpay.com"]` on every block rule
 * `limit/rules.ts` emits. That spreads a payment concern across the enforcement module,
 * has to be repeated on each of the three rule shapes there, and is silently wrong the
 * moment a fourth shape is added. One allow rule at a higher priority is the same effect
 * in one place, and it reads as what it is.
 *
 * The priority is above `limit/rules.ts`'s 3 rather than equal to it. Chrome only falls
 * back to the allow > block ordering to break a tie within one priority, so an equal
 * number would work today and would depend on a tie-break rule holding rather than on a
 * number — and this is not a thing to leave resting on a tie.
 */

import { RESOURCE_TYPES } from "../core/types";
import type { RuleSpec } from "../rules/session";

/** Above `limit/rules.ts`'s PRIORITY of 3 and `optimize/rules.ts`'s 2. */
const PRIORITY = 4;

/**
 * The provider's origin, and only it.
 *
 * `requestDomains` matches the domain and its subdomains, which is what is wanted: the
 * library talks to `extensionpay.com` today and the hosted pages pull their assets from
 * the same place. Nothing else is exempted from a limit anywhere in this extension, and
 * nothing else should be — an allow list is a hole in a feature people are relying on,
 * so it holds exactly the host that has to be reachable for the product to be able to
 * tell whether it is being paid for.
 */
const PROVIDER_DOMAIN = "extensionpay.com";

export const PLUS_ALLOW_RULES: readonly RuleSpec[] = [
  {
    priority: PRIORITY,
    action: { type: "allow" },
    condition: {
      // Every type, spelled out from the shared list rather than omitted. Leaving
      // `resourceTypes` off would also mean "all types" to Chrome, but every other rule
      // in this extension states its types, and a condition that is empty on purpose is
      // indistinguishable from one that lost its contents in an edit.
      resourceTypes: [...RESOURCE_TYPES],
      requestDomains: [PROVIDER_DOMAIN],
    },
  },
];
