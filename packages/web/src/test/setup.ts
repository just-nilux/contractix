import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * jsdom implements no `<dialog>` behaviour at all - `showModal` is simply
 * absent. This models the two parts the app depends on: opening sets `open`,
 * and Escape dispatches a *cancelable* `cancel` event which closes the dialog
 * only if nothing prevents it. That is precisely the hook the disclaimer gate
 * overrides to be non-dismissable, so a test against this polyfill is testing
 * our handler rather than the shim.
 *
 * It is still a model of a browser, not a browser: that the gate really blocks
 * is asserted once for real in the Playwright smoke test.
 */
if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  const listeners = new WeakMap<HTMLDialogElement, (e: KeyboardEvent) => void>();

  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (this.dispatchEvent(new Event("cancel", { cancelable: true }))) this.close();
    };
    listeners.set(this, onKeyDown);
    document.addEventListener("keydown", onKeyDown);
  };

  HTMLDialogElement.prototype.show = function show(this: HTMLDialogElement) {
    this.open = true;
  };

  HTMLDialogElement.prototype.close = function close(
    this: HTMLDialogElement,
    returnValue?: string,
  ) {
    this.open = false;
    if (returnValue !== undefined) this.returnValue = returnValue;
    const onKeyDown = listeners.get(this);
    if (onKeyDown) {
      document.removeEventListener("keydown", onKeyDown);
      listeners.delete(this);
    }
    this.dispatchEvent(new Event("close"));
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});
