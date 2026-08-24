export const SHAPES = ["sphere", "capsule", "rounded-cube", "diamond", "bean", "shield"] as const;
export type FaceShape = (typeof SHAPES)[number];
