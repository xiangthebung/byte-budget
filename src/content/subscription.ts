/**
 * Bridges ExtensionPay's completion page back to the service worker.
 *
 * This file is a classic content script and deliberately imports nothing. It accepts
 * only messages sent by the page to itself on ExtensionPay's HTTPS origin, acknowledges
 * the provider's event, then asks the worker to refresh the reduced subscription state.
 */

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.origin !== "https://extensionpay.com" || event.source !== window) return;
  if (event.data !== "extpay-fetch-user" && event.data !== "extpay-trial-start") return;

  window.postMessage(`${event.data}-received`, event.origin);
  void chrome.runtime
    .sendMessage({
      type: "PLUS_PROVIDER_EVENT",
      event: event.data === "extpay-fetch-user" ? "payment" : "trial",
    })
    .catch(() => undefined);
});
