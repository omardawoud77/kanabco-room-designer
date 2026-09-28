import type { CatalogProduct } from "./catalog";
import { CONCEPT_COLORS, CONCEPT_MATERIALS, PROJECT_TYPES, type ConceptColor, type ConceptMaterial, type ProjectType } from "./custom-projects";

const STYLE_BRIEFS = {
  "warm-minimal": "warm minimal styling, soft neutrals, restrained accessories",
  modern: "clean modern styling, crisp contrast, few accessories",
  earthy: "earthy styling, natural textures, warm wood and tactile accessories",
} as const;

export type RoomStyle = keyof typeof STYLE_BRIEFS;

export function buildRoomPrompt(input: {
  projectType: ProjectType;
  product: CatalogProduct | null;
  style: RoomStyle;
  color: ConceptColor;
  material: ConceptMaterial;
  roomWidthCm?: number;
}): string {
  const width = input.roomWidthCm ? `The customer estimates the room width at ${input.roomWidthCm} cm; do not treat this as a verified survey.` : "The room has no verified measurements.";
  const project = PROJECT_TYPES[input.projectType];
  const focalPiece = input.product
    ? `Image 2 is the approved Kanabco ${input.product.name} sofa reference. Add a sofa inspired by its recognizable silhouette. Product description: ${input.product.description}`
    : `Visualize ${project.brief}. This is a new custom-project idea, not an existing Kanabco catalog product. Do not imply it is available for purchase or has an approved price.`;
  return [
    `Create one realistic interior-design concept for a possible ${project.label.toLowerCase()} project. Image 1 is the customer's room.`,
    "Preserve the room's camera angle, walls, windows, doors, floor, ceiling and fixed architecture. Do not invent major architectural changes.",
    focalPiece,
    `Concept color: ${CONCEPT_COLORS[input.color]}. Material direction: ${CONCEPT_MATERIALS[input.material]}. Style: ${STYLE_BRIEFS[input.style]}. These are visual preferences only, not confirmed manufacturing choices. Add modest complementary decor where appropriate.`,
    "Use realistic scale and circulation. For kitchens and built-in storage, do not imply that utilities, structure, ventilation, access, or building rules have been assessed. Do not add logos, text, watermarks, people, or brand claims. Do not depict decor as a Kanabco product.",
    width,
    "This is illustrative only. A specialist must check feasibility, measurements, materials, availability, and price before any order.",
  ].join(" ");
}
