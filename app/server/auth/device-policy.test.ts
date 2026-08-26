import { describe, expect, it } from "vitest";
import { hasReachedDeviceLimit } from "./device-policy";

describe("two-device policy", () => {
  it("does not revoke a device while fewer than two devices are active", () => {
    const result = hasReachedDeviceLimit(
      [{ deviceKeyHash: "pc" }],
      "phone",
    );

    expect(result).toBe(false);
  });

  it("blocks a third distinct device without revoking an existing one", () => {
    const result = hasReachedDeviceLimit(
      [
        { deviceKeyHash: "pc" },
        { deviceKeyHash: "laptop" },
      ],
      "phone",
    );

    expect(result).toBe(true);
  });

  it("does not block a login from an existing device", () => {
    const result = hasReachedDeviceLimit(
      [
        { deviceKeyHash: "pc" },
        { deviceKeyHash: "laptop" },
      ],
      "laptop",
    );

    expect(result).toBe(false);
  });

  it("counts distinct device keys rather than sessions", () => {
    const result = hasReachedDeviceLimit(
      [{ deviceKeyHash: "pc" }, { deviceKeyHash: "pc" }, { deviceKeyHash: "laptop" }],
      "phone",
    );

    expect(result).toBe(true);
  });
});
