export const ENHANCEMENT_STATUSES = [
  "Pending Review", "Approved", "Not Approved", "Pending Development",
  "In Development", "Testing", "Live",
] as const;
export type EnhancementStatus = typeof ENHANCEMENT_STATUSES[number];
