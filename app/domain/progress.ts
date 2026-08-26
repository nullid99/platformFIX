export type ProgressItem = {
  progress: number;
};

export function calculatePracticumProgress(items: readonly ProgressItem[]): number {
  if (items.length === 0) return 0;

  const total = items.reduce((sum, item) => {
    const progress = Math.min(100, Math.max(0, item.progress));
    return sum + progress;
  }, 0);

  return Math.round(total / items.length);
}
