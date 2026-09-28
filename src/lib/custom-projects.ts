export const PROJECT_TYPES = {
  sofa: { label: "Sofa", brief: "a custom sofa suited to the room's seating area" },
  bed: { label: "Bed & headboard", brief: "a custom bed and headboard suited to the bedroom" },
  wardrobe: { label: "Wardrobe", brief: "a custom wardrobe integrated with the available wall space" },
  dresser: { label: "Dresser", brief: "a custom dresser suited to the room" },
  "dressing-room": { label: "Dressing room", brief: "a custom dressing-room storage layout suited to the visible space" },
  kitchen: { label: "Kitchen", brief: "a custom kitchen cabinetry concept suited to the existing room" },
} as const;

export type ProjectType = keyof typeof PROJECT_TYPES;

export const CONCEPT_COLORS = {
  "warm-ivory": "warm ivory",
  sand: "sand",
  taupe: "taupe",
  sage: "sage green",
  walnut: "walnut brown",
  charcoal: "charcoal",
} as const;

export type ConceptColor = keyof typeof CONCEPT_COLORS;

export const CONCEPT_MATERIALS = {
  upholstery: "upholstery",
  wood: "wood",
  laminate: "laminate",
  stone: "stone",
  mixed: "a considered mix of suitable materials",
} as const;

export type ConceptMaterial = keyof typeof CONCEPT_MATERIALS;

export const ALLOWED_MATERIALS: Record<ProjectType, readonly ConceptMaterial[]> = {
  sofa: ["upholstery", "wood", "mixed"],
  bed: ["upholstery", "wood", "mixed"],
  wardrobe: ["wood", "laminate", "mixed"],
  dresser: ["wood", "laminate", "stone", "mixed"],
  "dressing-room": ["wood", "laminate", "mixed"],
  kitchen: ["wood", "laminate", "stone", "mixed"],
};
