/** Discord user IDs are snowflakes represented as 17–20 decimal digits. */
export function isDiscordUserId(value: string): boolean {
  return /^\d{17,20}$/.test(value.trim());
}
