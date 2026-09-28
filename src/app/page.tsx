"use client";

import { ChangeEvent, DragEvent, FormEvent, useEffect, useRef, useState } from "react";
import { Turnstile } from "@/components/Turnstile";
import { ALLOWED_MATERIALS, type ConceptColor, type ConceptMaterial as Material, type ProjectType } from "@/lib/custom-projects";

type CatalogProduct = {
  id: string;
  name: string;
  category: string;
  imageUrl?: string;
  productUrl: string;
  priceEgp: number | null;
  materials: string[];
  colors: string[];
};

type ResultProject = {
  type: ProjectType;
  label: string;
  source: "custom-concept" | "catalog-reference";
  productId: string | null;
  productName: string | null;
  productUrl: string | null;
  priceEgp: number | null;
  priceNote: string;
};

type DesignResult = {
  imageDataUrl: string;
  project: ResultProject;
  conceptDisclaimer: string;
  requestId: string;
};

type StyleId = "warm-minimal" | "modern" | "earthy";

const STYLES: { id: StyleId; name: string; description: string }[] = [
  { id: "warm-minimal", name: "Warm minimal", description: "Soft neutrals and calm lines" },
  { id: "modern", name: "Modern", description: "Clean forms and crisp contrast" },
  { id: "earthy", name: "Earthy", description: "Natural texture and warm tones" },
];

const PROJECT_TYPES: { id: ProjectType; name: string; description: string; defaultMaterial: Material }[] = [
  { id: "sofa", name: "Sofa", description: "A seating idea for your living room", defaultMaterial: "upholstery" },
  { id: "bed", name: "Bed & headboard", description: "A restful bedroom direction", defaultMaterial: "upholstery" },
  { id: "wardrobe", name: "Wardrobe", description: "Storage fitted to your space", defaultMaterial: "wood" },
  { id: "dresser", name: "Dresser", description: "A storage or vanity idea", defaultMaterial: "wood" },
  { id: "dressing-room", name: "Dressing room", description: "A room for clothes and accessories", defaultMaterial: "wood" },
  { id: "kitchen", name: "Kitchen", description: "A new cabinet and finish concept", defaultMaterial: "wood" },
];

const CATEGORY_CARDS: { id: ProjectType; image: string; label: string; detail: string; catalog: boolean }[] = [
  { id: "sofa", image: "/brand/sofa-room.webp", label: "Sofas", detail: "Explore a sofa shape and placement for your room.", catalog: true },
  { id: "bed", image: "/concepts/bed.webp", label: "Beds & headboards", detail: "Imagine a softer bedroom with a new focal point.", catalog: false },
  { id: "wardrobe", image: "/concepts/wardrobe.webp", label: "Wardrobes", detail: "See a storage direction for your space.", catalog: false },
  { id: "dresser", image: "/concepts/dresser.webp", label: "Dressers", detail: "Try a considered vanity or storage idea.", catalog: false },
  { id: "dressing-room", image: "/concepts/dressing-room.webp", label: "Dressing rooms", detail: "Picture an organised room with a new layout.", catalog: false },
  { id: "kitchen", image: "/concepts/kitchen.webp", label: "Kitchens", detail: "Explore a cabinet and finish concept.", catalog: false },
];

const MATERIALS: { id: Material; name: string }[] = [
  { id: "upholstery", name: "Upholstery" },
  { id: "wood", name: "Wood" },
  { id: "laminate", name: "Laminate" },
  { id: "stone", name: "Stone" },
  { id: "mixed", name: "Mixed materials" },
];

const COLORS: { id: ConceptColor; name: string }[] = [
  { id: "warm-ivory", name: "Warm ivory" },
  { id: "sand", name: "Sand" },
  { id: "taupe", name: "Taupe" },
  { id: "sage", name: "Sage" },
  { id: "walnut", name: "Walnut" },
  { id: "charcoal", name: "Charcoal" },
];

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const WAIT_LIMIT_MS = 250_000;

function safeCatalogImage(value?: string) {
  return value && /^\/products\/[a-z0-9-]+\.(png|jpe?g|webp)$/i.test(value) ? value : null;
}

function safeProductUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value, "https://kanabco.net");
    return url.protocol === "https:" && url.hostname === "kanabco.net" ? url.href : null;
  } catch {
    return null;
  }
}

function responseError(status: number) {
  if (status === 413) return "This photo is too large. Choose an image under 8 MB.";
  if (status === 429) return "The design studio is busy or your free limit has been reached. Please try again later.";
  if (status === 503) return "The design studio is temporarily unavailable. Please try again later.";
  if (status === 400 || status === 403) return "We could not verify this request. Complete the security check again and retry.";
  return "Your design could not be created right now. Please try again later.";
}

function isDesignResult(value: unknown): value is DesignResult {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<DesignResult>;
  return (
    typeof item.imageDataUrl === "string" &&
    /^data:image\/(png|jpeg|webp);base64,/.test(item.imageDataUrl) &&
    typeof item.conceptDisclaimer === "string" &&
    typeof item.requestId === "string" &&
    !!item.project &&
    PROJECT_TYPES.some(({ id }) => id === item.project?.type) &&
    typeof item.project.label === "string" &&
    (item.project.source === "custom-concept" || item.project.source === "catalog-reference") &&
    (item.project.productId === null || typeof item.project.productId === "string") &&
    (item.project.productName === null || typeof item.project.productName === "string") &&
    (item.project.productUrl === null || typeof item.project.productUrl === "string") &&
    item.project.priceEgp === null &&
    typeof item.project.priceNote === "string"
  );
}

function isCatalogProduct(value: unknown): value is CatalogProduct {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<CatalogProduct>;
  return (
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    typeof item.category === "string" &&
    typeof item.productUrl === "string" &&
    (item.imageUrl === undefined || typeof item.imageUrl === "string") &&
    (item.priceEgp === null || (typeof item.priceEgp === "number" && Number.isFinite(item.priceEgp))) &&
    Array.isArray(item.materials) && item.materials.every((material) => typeof material === "string") &&
    Array.isArray(item.colors) && item.colors.length > 0 && item.colors.every((color) => typeof color === "string")
  );
}

function Icon({ kind }: { kind: "upload" | "sparkles" | "arrow" }) {
  if (kind === "upload") {
    return (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 16V4m0 0L8 8m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === "arrow") {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 12h15m0 0-6-6m6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m12 2 1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2Zm7 14 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export default function Home() {
  const [catalog, setCatalog] = useState<CatalogProduct[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [siteKey, setSiteKey] = useState("");
  const [localTestMode, setLocalTestMode] = useState(false);
  const [setupError, setSetupError] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoUrl, setPhotoUrl] = useState("");
  const [photoError, setPhotoError] = useState("");
  const [projectType, setProjectType] = useState<ProjectType>("sofa");
  const [productId, setProductId] = useState("");
  const [color, setColor] = useState<ConceptColor>("warm-ivory");
  const [material, setMaterial] = useState<Material>("upholstery");
  const [style, setStyle] = useState<StyleId>("warm-minimal");
  const [roomWidthCm, setRoomWidthCm] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [resetNonce, setResetNonce] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [submitError, setSubmitError] = useState("");
  const [result, setResult] = useState<DesignResult | null>(null);
  const resultRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/config", { cache: "no-store", credentials: "same-origin" })
      .then(async (configResponse) => {
        if (!configResponse.ok) throw new Error("Setup unavailable");
        const config: unknown = await configResponse.json();
        if (!config || typeof config !== "object" || typeof (config as { turnstileSiteKey?: unknown }).turnstileSiteKey !== "string" || !(config as { turnstileSiteKey: string }).turnstileSiteKey || typeof (config as { localTestMode?: unknown }).localTestMode !== "boolean") {
          throw new Error("Invalid config");
        }
        if (active) {
          setSiteKey((config as { turnstileSiteKey: string }).turnstileSiteKey);
          setLocalTestMode((config as { localTestMode: boolean }).localTestMode);
        }
      })
      .catch(() => {
        if (active) setSetupError("The design studio is unavailable right now. Please refresh later.");
      });
    fetch("/api/catalog", { cache: "no-store", credentials: "same-origin" })
      .then(async (catalogResponse) => {
        if (!catalogResponse.ok) throw new Error("Catalog unavailable");
        const catalogData: unknown = await catalogResponse.json();
        if (!catalogData || typeof catalogData !== "object" || !Array.isArray((catalogData as { products?: unknown }).products)) {
          throw new Error("Invalid catalog");
        }
        const products = (catalogData as { products: unknown[] }).products.filter(isCatalogProduct);
        if (active) {
          setCatalog(products);
          setCatalogLoaded(true);
        }
      })
      .catch(() => {
        if (active) {
          setCatalogLoaded(true);
          setCatalogError("Kanabco product references are unavailable. You can still explore a custom concept.");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!photo) {
      setPhotoUrl("");
      return;
    }
    const url = URL.createObjectURL(photo);
    setPhotoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  useEffect(() => {
    if (!submitting) return;
    const started = Date.now();
    const interval = window.setInterval(() => setElapsedSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(interval);
  }, [submitting]);

  useEffect(() => {
    if (result) resultRef.current?.focus();
  }, [result]);

  const product = catalog.find((item) => item.id === productId);
  const validWidth = !roomWidthCm || (/^\d{3,4}$/.test(roomWidthCm) && Number(roomWidthCm) >= 180 && Number(roomWidthCm) <= 1000);
  const canSubmit = !!photo && !!turnstileToken && validWidth && !submitting && !setupError;

  function choosePhoto(file?: File) {
    setSubmitError("");
    setResult(null);
    if (!file) return;
    if (!ACCEPTED_TYPES.has(file.type)) {
      setPhoto(null);
      setPhotoError("Choose a JPG, PNG, or WebP photo.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setPhoto(null);
      setPhotoError("Choose a photo smaller than 8 MB.");
      return;
    }
    setPhotoError("");
    setPhoto(file);
  }

  function onPhotoChange(event: ChangeEvent<HTMLInputElement>) {
    choosePhoto(event.target.files?.[0]);
    event.target.value = "";
  }

  function onPhotoDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    choosePhoto(event.dataTransfer.files?.[0]);
  }

  function chooseProject(id: ProjectType) {
    setProjectType(id);
    setProductId("");
    setMaterial(PROJECT_TYPES.find((item) => item.id === id)?.defaultMaterial ?? ALLOWED_MATERIALS[id][0]);
    setResult(null);
  }

  function chooseCategory(id: ProjectType) {
    chooseProject(id);
    document.getElementById("studio")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }

  function chooseProduct(id: string) {
    setProductId(id);
    setResult(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || !photo || !turnstileToken) return;
    setSubmitError("");
    setResult(null);
    setSubmitting(true);
    setElapsedSeconds(0);

    const form = new FormData();
    form.set("image", photo);
    form.set("projectType", projectType);
    if (projectType === "sofa" && productId) form.set("productId", productId);
    form.set("style", style);
    form.set("color", color);
    form.set("material", material);
    if (roomWidthCm) form.set("roomWidthCm", roomWidthCm);
    form.set("turnstileToken", turnstileToken);

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), WAIT_LIMIT_MS);
    try {
      const response = await fetch("/api/room-design", {
        method: "POST",
        credentials: "same-origin",
        headers: { "X-Requested-With": "website" },
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(responseError(response.status));
      const data: unknown = await response.json();
      if (!isDesignResult(data)) throw new Error("Your design could not be displayed. Please try again later.");
      setResult(data);
    } catch (error) {
      setSubmitError(
        error instanceof DOMException && error.name === "AbortError"
          ? "This design took too long. Please wait before starting another request."
          : error instanceof Error
            ? error.message
            : "Your design could not be created right now. Please try again later.",
      );
    } finally {
      window.clearTimeout(timeout);
      setSubmitting(false);
      setTurnstileToken(null);
      setResetNonce((value) => value + 1);
    }
  }

  return (
    <main>
      <a className="skip-link" href="#studio">Skip to room designer</a>
      <header className="site-header">
        <div className="shell header-inner">
          <a className="brand" href="https://kanabco.net" aria-label="Kanabco home">
            <img src="/brand/kanabco-logo.png" alt="" /><span className="brand-divider" aria-hidden="true" /><strong>custom</strong>
          </a>
          <nav aria-label="Main navigation">
            <a href="https://kanabco.net">Products</a>
            <a href="https://kanabco.net/about">Our Story</a>
            <a className="nav-active" href="#studio" aria-current="page">Customization</a>
            <a href="https://kanabco.net/#contact-cta">Contact</a>
          </nav>
        </div>
      </header>

      <section className="hero shell" aria-labelledby="hero-title">
        <div className="hero-copy">
          <span className="eyebrow">NEW · ROOM DESIGN STUDIO</span>
          <h1 id="hero-title">Your space.<br />Your vision.<br /><span>Imagined with Kanabco.</span></h1>
          <p>Share a photo of your room and explore what a sofa, bed, wardrobe or kitchen could look like in it. Choose a style and materials, then see one AI design concept made around your space.</p>
          <a href="#categories" className="button button-primary">Start customizing <Icon kind="arrow" /></a>
          <p className="hero-note">Visual inspiration · A specialist confirms what can be made and quoted</p>
        </div>
        <div className="hero-art">
          <img src="/brand/sofa-room.webp" alt="A cream Kanabco sofa from the current collection" />
          <span className="art-caption">The starting point is yours</span>
        </div>
      </section>

      <section className="steps shell" aria-label="How it works">
        <div><span>01</span><strong>Choose an idea</strong><small>Pick what you want to explore</small></div>
        <div><span>02</span><strong>Share a photo</strong><small>Show us your real room</small></div>
        <div><span>03</span><strong>Make it yours</strong><small>Choose style, colour and material</small></div>
        <div><span>04</span><strong>See your concept</strong><small>Discuss it with a specialist</small></div>
      </section>

      <section className="categories shell" id="categories" aria-labelledby="categories-title">
        <div className="section-heading category-heading">
          <span className="eyebrow">A PLACE TO START</span>
          <h2 id="categories-title">What could we imagine for you?</h2>
          <p>Choose a direction, then show us your room. Sofas can use a Kanabco catalog reference. Beds, kitchens and other spaces are exploratory ideas until a specialist confirms what is available.</p>
        </div>
        <div className="category-grid">
          {CATEGORY_CARDS.map((item) => (
            <button key={item.id} className={`category-card ${projectType === item.id ? "category-selected" : ""}`} type="button" onClick={() => chooseCategory(item.id)} aria-label={`Explore ${item.label}`}>
              <span className={`category-image category-${item.id}`}><img src={item.image} alt="" loading="lazy" /></span>
              <span className="category-body">
                <span className="category-meta">{item.catalog ? "KANABCO SOFA REFERENCE AVAILABLE" : "EXPLORATORY CONCEPT"}</span>
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
                <span className="category-action">Explore this idea <span aria-hidden="true">→</span></span>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="studio shell" id="studio" tabIndex={-1} aria-labelledby="studio-title">
        <div className="section-heading">
          <span className="eyebrow">SHOW US YOUR SPACE</span>
          <h2 id="studio-title">Now make it yours.</h2>
          <p>Use a clear room photo, choose your favourite direction and create one visual concept. The result is a conversation starter for the Kanabco team.</p>
        </div>

        <form onSubmit={submit} className="studio-grid" aria-busy={submitting}>
          <div className="form-panel">
            {setupError && <p role="alert" className="notice notice-error">{setupError}</p>}

            <fieldset className="form-section">
              <legend><span className="section-number">1</span> Your room photo</legend>
              <p className="section-help">Use a well-lit photo that clearly shows the area you want to redesign.</p>
              <label className={`upload-zone ${photoUrl ? "has-photo" : ""}`} htmlFor="room-photo" onDragOver={(event) => event.preventDefault()} onDrop={onPhotoDrop}>
                <input id="room-photo" className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" onChange={onPhotoChange} disabled={submitting} aria-describedby="photo-help photo-error" />
                {photoUrl ? (
                  <><img src={photoUrl} alt="Preview of your uploaded room" /><span className="upload-change">Change photo</span></>
                ) : (
                  <><span className="upload-icon"><Icon kind="upload" /></span><strong>Drop a photo here, or choose a file</strong><small>JPG, PNG or WebP · Up to 8 MB</small></>
                )}
              </label>
              <p id="photo-help" className="microcopy">We send your photo to OpenAI to create one concept. Avoid showing people or private information.</p>
              {photoError && <p id="photo-error" role="alert" className="field-error">{photoError}</p>}
            </fieldset>

            <fieldset className="form-section">
              <legend><span className="section-number">2</span> What would you like to explore?</legend>
              <p className="section-help">Select a custom project idea. These categories are visual concepts, not confirmed Kanabco product lines.</p>
              <div className="project-types" role="group" aria-label="Project type">
                {PROJECT_TYPES.map((item) => (
                  <label key={item.id} className={`project-type ${projectType === item.id ? "selected" : ""} ${submitting ? "disabled" : ""}`}>
                    <input className="visually-hidden" type="radio" name="project-type" value={item.id} checked={projectType === item.id} onChange={() => chooseProject(item.id)} disabled={submitting} />
                    <strong>{item.name}</strong><small>{item.description}</small>
                  </label>
                ))}
              </div>
              {projectType === "sofa" && (
                <div className="reference-group">
                  <h3>Kanabco sofa reference <span>(optional)</span></h3>
                  <p>Choose an existing sofa for visual direction, or create a custom sofa idea. The image may differ from the real product.</p>
                  {catalogError && <p className="microcopy" role="status">{catalogError}</p>}
                  {!catalogLoaded && <p className="catalog-loading" role="status">Loading sofa references…</p>}
                  {catalogLoaded && (
                    <div className="product-list" role="group" aria-label="Optional sofa reference">
                      <label className={`product-card ${!productId ? "selected" : ""} ${submitting ? "disabled" : ""}`}>
                        <input className="visually-hidden" type="radio" name="sofa-reference" value="" checked={!productId} onChange={() => chooseProduct("")} disabled={submitting} />
                        <span className="product-category">Custom idea</span><strong>No catalog reference</strong><small>Imagine a new sofa concept</small>
                      </label>
                      {catalog.filter((item) => item.category.toLowerCase().includes("sofa")).map((item) => (
                        <label key={item.id} className={`product-card ${productId === item.id ? "selected" : ""} ${submitting ? "disabled" : ""}`}>
                          <input className="visually-hidden" type="radio" name="sofa-reference" value={item.id} checked={productId === item.id} onChange={() => chooseProduct(item.id)} disabled={submitting} />
                          {safeCatalogImage(item.imageUrl) && <img className="product-image" src={safeCatalogImage(item.imageUrl)!} alt="" />}
                          <span className="product-category">Kanabco reference</span>
                          <strong>{item.name}</strong>
                          <small>Specialist confirms availability and price</small>
                        </label>
                      ))}
                    </div>
                  )}
                  {product && (
                    <div className="product-detail">
                      {product.materials.length > 0 && <p><strong>Product details:</strong> {product.materials.join(", ")}</p>}
                      {safeProductUrl(product.productUrl) && <a href={safeProductUrl(product.productUrl)!} target="_blank" rel="noopener noreferrer">View sofa reference <span aria-hidden="true">↗</span></a>}
                    </div>
                  )}
                </div>
              )}
            </fieldset>

            <fieldset className="form-section">
              <legend><span className="section-number">3</span> Set the mood</legend>
              <div className="style-options">
                {STYLES.map((item) => (
                  <label className={`style-option ${style === item.id ? "selected" : ""}`} key={item.id}>
                    <input type="radio" name="style" value={item.id} checked={style === item.id} onChange={() => { setStyle(item.id); setResult(null); }} disabled={submitting} />
                    <span><strong>{item.name}</strong><small>{item.description}</small></span>
                  </label>
                ))}
              </div>
              <div className="finish-fields">
                <div>
                  <label className="width-label" htmlFor="concept-material">Material direction</label>
                  <select id="concept-material" className="finish-select" value={material} onChange={(event) => { setMaterial(event.target.value as Material); setResult(null); }} disabled={submitting}>
                    {MATERIALS.filter((item) => ALLOWED_MATERIALS[projectType].includes(item.id)).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="width-label" htmlFor="concept-color">Colour direction</label>
                  <select id="concept-color" className="finish-select" value={color} onChange={(event) => { setColor(event.target.value as ConceptColor); setResult(null); }} disabled={submitting}>
                    {COLORS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </div>
              </div>
              <p className="microcopy finish-note">These are concept preferences, not confirmed Kanabco materials or finishes.</p>
              <label className="width-label" htmlFor="room-width">Room width in cm <span>(optional)</span></label>
              <input id="room-width" className="text-input" type="text" inputMode="numeric" pattern="[0-9]{3,4}" maxLength={4} placeholder="e.g. 420" value={roomWidthCm} onChange={(event) => { setRoomWidthCm(event.target.value.replace(/\D/g, "").slice(0, 4)); setResult(null); }} disabled={submitting} aria-invalid={!validWidth} aria-describedby="width-help" />
              <p id="width-help" className={validWidth ? "microcopy" : "field-error"}>Enter 180–1000 cm if you know it. An advisor must still verify measurements.</p>
            </fieldset>

            <div className="submit-section">
              {siteKey && <Turnstile siteKey={siteKey} localTestMode={localTestMode} onTokenChange={setTurnstileToken} resetNonce={resetNonce} />}
              <button className="button button-primary submit-button" type="submit" disabled={!canSubmit} aria-describedby="submit-help">
                {submitting ? "Creating your concept…" : "Create my room concept"} {!submitting && <Icon kind="arrow" />}
              </button>
              <p id="submit-help" className="microcopy">{submitting ? `Please keep this page open. ${elapsedSeconds}s elapsed; this can take up to 4 minutes.` : !canSubmit ? "Add a photo and complete verification to continue." : "Ready to create one concept image."}</p>
              {submitting && <div className="loading-track" aria-hidden="true"><span /></div>}
              {submitError && <p role="alert" className="notice notice-error">{submitError}</p>}
              <p className="terms-note">Automated or scripted use is prohibited. We may limit or block abusive activity.</p>
            </div>
          </div>

          <aside className="preview-panel" aria-label="Room design preview" ref={resultRef} tabIndex={-1}>
            <div className="preview-top"><span className="preview-icon"><Icon kind="sparkles" /></span><span>YOUR PREVIEW</span></div>
            {result && photoUrl ? (
              <div className="result-content">
                <div className="image-pair">
                  <figure><img src={photoUrl} alt="Your original room before the design" /><figcaption>Before · Your photo</figcaption></figure>
                  <figure><img src={result.imageDataUrl} alt={`AI-generated ${result.project.label} concept`} /><figcaption>After · Design concept</figcaption></figure>
                </div>
                <div className="result-product">
                  <span className="eyebrow">{result.project.source === "catalog-reference" ? "SOFA REFERENCE" : "CUSTOM PROJECT IDEA"}</span>
                  <h3>{result.project.productName ?? result.project.label}</h3>
                  <p>No instant price</p>
                  {result.project.priceNote && <small>{result.project.priceNote}</small>}
                </div>
                <p className="concept-disclaimer">{result.conceptDisclaimer}</p>
                <a className="download-link" href={result.imageDataUrl} download="kanabco-room-concept.jpg">Download concept image</a>
                <p className="request-id">Reference: {result.requestId}</p>
                <a className="button button-primary advisor-button" href="https://kanabco.net" target="_blank" rel="noopener noreferrer">Visit Kanabco website <Icon kind="arrow" /></a>
                <p className="share-note">Download the image, then contact Kanabco and share it and this reference with a specialist yourself. Nothing is sent automatically. Ask whether this type of project can be made before discussing a quote.</p>
              </div>
            ) : (
              <div className="preview-empty">
                {photoUrl ? <img src={photoUrl} alt="Your uploaded room, ready for a design concept" /> : <div className="preview-placeholder"><Icon kind="sparkles" /><span>Your room goes here</span></div>}
                <div className="preview-empty-copy"><strong>{submitting ? "Making room for new ideas…" : photoUrl ? "Your room is ready" : "See the possibility"}</strong><p>{submitting ? "We’re preparing your concept. Please keep this page open." : "Your before and after views will appear here once your concept is ready."}</p></div>
              </div>
            )}
            <div className="preview-footer">Concept only · Product range, feasibility, dimensions, finishes, and price require specialist confirmation.</div>
          </aside>
        </form>
      </section>

      <section className="closing shell" aria-labelledby="closing-title">
        <span className="eyebrow">MADE WITH YOU</span>
        <h2 id="closing-title">A first look. Then the real conversation.</h2>
        <p>Use the preview to explain what you love. Ask a Kanabco specialist whether the project is offered, what can be made, and how it would be measured and quoted.</p>
      </section>

      <footer className="site-footer"><div className="shell"><div className="footer-brand"><img src="/brand/kanabco-logo-white.png" alt="Kanabco" /><span>room designer</span></div><p>AI concepts are visual inspiration. They do not confirm that Kanabco offers a category or can make the pictured design.</p></div></footer>
    </main>
  );
}
