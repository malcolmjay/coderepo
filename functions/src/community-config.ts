// Shared by the browser and server; Storage rules enforce the same byte limit.
export const COMMUNITY_MAX_BYTES = 1024 ** 3;
export const COMMUNITY_MAX_LABEL = "1 GiB";
export const COMMUNITY_CATEGORIES = {models: "3D files", software: "Code & software"} as const;
export const COMMUNITY_SHARING = {
  version: "2026-10-07",
  agreement: "I created these files or have permission to share them. I agree to share them with authorized Camera Hacks customers for personal, non-commercial use.",
} as const;
