export const space = { xs: 4, sm: 8, md: 12, lg: 20, xl: 28, xxl: 40 };
export const radius = { small: 10, medium: 16, large: 24, pill: 999 };
export const labels = { features: "Features" } as const;

export function approvalLabel(count: number): string {
  return `${count} ${count === 1 ? "needs" : "need"} approval`;
}
