export type ActiveDeviceSession = {
  deviceKeyHash: string | null;
};

/** Returns true when a new device would exceed the distinct-device limit. */
export function hasReachedDeviceLimit(
  sessions: readonly ActiveDeviceSession[],
  incomingDeviceKeyHash: string,
  maximumDevices = 2,
): boolean {
  const groups = new Set<string>();

  for (const session of sessions) {
    if (!session.deviceKeyHash || session.deviceKeyHash === incomingDeviceKeyHash) {
      continue;
    }
    groups.add(session.deviceKeyHash);
  }

  return groups.size >= maximumDevices;
}
