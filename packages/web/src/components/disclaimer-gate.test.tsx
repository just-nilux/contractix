import { DISCLAIMER } from "@contractix/shared/schemas";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { DisclaimerGate } from "./disclaimer-gate.js";

const ACK_KEY = "ctx.disclaimer.ack";

describe("DisclaimerGate", () => {
  it("shows the API's own disclaimer text on a first visit", () => {
    render(<DisclaimerGate />);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // Imported from shared, never retyped: the modal and every report say the
    // same sentence or FR-7.6 is only half kept.
    expect(screen.getByText(DISCLAIMER)).toBeInTheDocument();
  });

  it("offers no way out except acknowledging", () => {
    render(<DisclaimerGate />);

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent("I understand");
  });

  it("does not close on Escape", async () => {
    const user = userEvent.setup();
    render(<DisclaimerGate />);

    await user.keyboard("{Escape}");

    // "Non-dismissable" is the requirement; a dialog that Escape closes is
    // dismissable no matter how few buttons it has.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(localStorage.getItem(ACK_KEY)).toBeNull();
  });

  it("dismisses and records the acknowledgement when accepted", async () => {
    const user = userEvent.setup();
    render(<DisclaimerGate />);

    await user.click(screen.getByRole("button", { name: "I understand" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(localStorage.getItem(ACK_KEY)).toBe("1");
  });

  it("stays out of the way once acknowledged", () => {
    localStorage.setItem(ACK_KEY, "1");

    render(<DisclaimerGate />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("re-prompts when the acknowledged version is older than the current text", () => {
    localStorage.setItem(ACK_KEY, "0");

    render(<DisclaimerGate />);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
