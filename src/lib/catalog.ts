import { readFile } from "node:fs/promises";
import path from "node:path";

export type CatalogProduct = {
  id: string;
  name: string;
  category: "Sofas";
  productUrl: string;
  imageUrl: string;
  referenceFile: string;
  priceEgp: number | null;
  priceNote: string;
  materials: string[];
  colors: string[];
  description: string;
};

// These product references are sourced from Kanabco's own catalogue kit.
// The price remains null until the storefront team supplies an approved variant price feed.
const products: CatalogProduct[] = [
  {
    id: "160",
    name: "Arcus",
    category: "Sofas",
    productUrl: "https://kanabco.net/product/160",
    imageUrl: "/products/arcus.png",
    referenceFile: "arcus.png",
    priceEgp: null,
    priceNote: "A Kanabco specialist confirms the selected fabric and final quote.",
    materials: ["Upholstered sofa"],
    colors: ["As pictured", "Warm ivory concept", "Sand concept"],
    description: "Sculptural curved sofa with a deep, continuous seat.",
  },
  {
    id: "158",
    name: "Noma",
    category: "Sofas",
    productUrl: "https://kanabco.net/product/158",
    imageUrl: "/products/noma.png",
    referenceFile: "noma.png",
    priceEgp: null,
    priceNote: "A Kanabco specialist confirms the selected fabric and final quote.",
    materials: ["Upholstered sofa"],
    colors: ["As pictured", "Warm ivory concept", "Sand concept"],
    description: "Low, relaxed sectional sofa with a chaise.",
  },
];

export function listProducts(): Omit<CatalogProduct, "referenceFile">[] {
  return products.map(({ referenceFile: _referenceFile, ...publicFields }) => publicFields);
}

export function findProduct(id: string): CatalogProduct | null {
  return products.find((product) => product.id === id) ?? null;
}

export async function productReference(product: CatalogProduct): Promise<Buffer> {
  return readFile(path.join(process.cwd(), "public", "products", product.referenceFile));
}
