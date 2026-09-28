# Kanabco Room Designer — integration brief

Share [SEND-TO-DEVS.md](SEND-TO-DEVS.md) with the package. This brief records product scope and launch acceptance; `README.md` contains the API gates, environment variables, dashboard steps, and abuse tests.

## Product decision for v1

Add the Room Designer as a separate customization feature beside the existing quote advisor. A visitor uploads one photo of their space and chooses **sofa, bed and headboard, wardrobe, dresser, dressing room, or kitchen**. They set a style, color, and material direction, then receive one AI-generated visual concept.

These are **six idea categories**, not six listings in Kanabco's catalog. Current confirmed made-to-order policy covers sofas/chairs; it does not establish that Kanabco sells or can produce the other categories. Show beds, wardrobes, dressers, dressing rooms, and kitchens as exploratory custom-project ideas. A specialist must first assess whether Kanabco can deliver the request, then confirm survey, materials, scope, timeline, and quote. Kitchen concepts require separate technical review for utilities, ventilation, structure, and installation. Never present the image as a measured design or an order specification.

The sofa category supports a new concept from controlled style/material choices or an optional reference to one of two example Kanabco sofas. All other categories use only the visitor's room photo and controlled server prompts; they need no existing SKU. Both sofa references need product-media verification before launch. No generated project shows an automatic price. The existing chatbot is unchanged because its source was not available.

The supplied screenshot is visual direction for the experience. Its category names and suggested prices do not establish a live catalog or approved production offer.

## Brand reference used for the UI

The UI was aligned with the [live Kanabco website](https://kanabco.net/) and its linked [Instagram profile](https://www.instagram.com/kanabco/) on 28 September 2026: navy `#18395c`, orange `#ed6b3e`, light backgrounds, rounded white cards, pill actions, Lato body typography, and warm ivory upholstery imagery. The header/footer logos and cream sofa visual were copied from the official site into `public/brand/`; the site team should confirm final asset selection during integration. The five bed/storage/kitchen card images in `public/concepts/` were generated for this demo and visibly labeled **Exploratory concept**. They are not Kanabco catalog media or evidence of available services.

## Developer integration sequence

1. Merge this isolated Next.js package into the live site as a route or subdomain, preserving the backend code and server-only secrets. If the live site is not Next.js, port the same checks and Redis scripts into its backend; retain the strict multipart field allowlist and exact gate order in `README.md`.
2. Keep `src/lib/custom-projects.ts` as the explicit allowlist of the six idea categories and material combinations. Confirm UI and API use the same enums. `productId` is optional **only for a sofa**; any product ID on a bed, wardrobe, dresser, dressing room, or kitchen request must be rejected.
3. Verify `src/lib/catalog.ts` and `public/products/` against approved sofa media. Connect a catalog or price source only for approved products; do not invent SKUs or prices for custom-project ideas. Every generated result currently returns `project.priceEgp: null` and tells the visitor to consult a specialist.
4. Review the Kanabco-matched header, footer, official logo/sofa media, Lato typography, and advisor entry point against the live site's current brand. The five generated category images are illustrative concepts and must remain labeled that way. Keep the category-wide disclaimer, before/after labels, and acceptable-use note visible. Style, color, and material choices are visual preferences, not promises about available finishes.
5. Decide how a customer may bring the result to an advisor. The package lets them download the concept and open Kanabco's website; they must find a contact option and share the image manually. There is **no automatic lead attachment**, server photo storage, or advisor message. A future automatic handoff requires explicit consent, access controls, encrypted private storage, short retention/deletion rules, and an advisor view.
6. Connect Cloudflare, Upstash, and the existing dedicated Kanabco OpenAI project. Provision a deployment secret through the hosting platform; keep the key out of the repository and handoff. Arrange static egress and IP allowlisting per `README.md`. Keep `AI_FEATURE_ENABLED=false` until staging abuse checks and category acceptance checks pass.
7. Review the source in the private `omardawoud77/kanabco-room-designer` repository. GitHub Actions runs typecheck, unit tests, real Redis Lua guard tests, and build. Integrate this package into the actual live site repository after confirming its stack and owners.

## Production integration status

This handoff has not been deployed. At the 29 September 2026 audit, the connected Vercel account had no Room Designer hosting project, `custom.kanabco.net` had no DNS record, and the live site's public DNS/response did not show a Cloudflare proxy. The live website repository and integration owner remain unconfirmed. The team must choose the approved route and host, configure the real Cloudflare WAF/Turnstile and trusted edge header, connect Upstash, provide fixed outbound IPs for OpenAI project allowlisting, and validate the completed path in staging before enabling public image calls.

## Launch acceptance

- All six categories can generate a concept from an appropriate room photo. The result labels each as a project idea and shows the specialist feasibility/quote note. None of the five concept-only categories appears as an existing Kanabco product or confirmed service.
- A sofa can be generated with no reference or with one verified catalog reference. Only the latter response carries product metadata. A non-sofa request with `productId` fails before an image edit.
- The live browser sends only `{ image, projectType, productId?, style, color, material, roomWidthCm?, turnstileToken }` to Kanabco's backend. No OpenAI request or secret appears in the client bundle.
- A room photo with visible people or private information is discouraged. The app does not persist the upload or generated image or log them by default.
- The privacy owner approves the photo-processing and retention notice, then sets its public HTTPS URL in `AI_PHOTO_PRIVACY_URL`. The production AI route remains unavailable without this URL, and the UI links it next to the upload control.
- The generated result is visibly illustrative. A kitchen preview does not claim utility, code, structure, installation, or fit verification. Materials and colors remain visual directions.
- Product specialists accept representative staging concepts from appropriate room photos for each of the six categories, including a sofa with an approved reference. The results must preserve permanent walls, windows, doors, fixtures, and proportions closely enough for a truthful concept. Reject or label results that materially alter them. The first direct kitchen smoke result changed window geometry; a later protected-route, aspect-matched result broadly preserved the same fictional room. This is a useful improvement, not acceptance for all categories.
- Wrong origin, direct-origin bypass, Turnstile replay, oversize image, quota exhaustion, Redis failure, and kill switch tests all block paid image edits.
- Staging Images Edit responses include consistent nonnegative integer `usage.input_tokens`, `usage.input_tokens_details.image_tokens`, `usage.input_tokens_details.text_tokens`, `usage.output_tokens`, and `usage.total_tokens` with and without a sofa reference. Missing or inconsistent fields trigger the daily breaker; resolve that before public use.
- Automated photo moderation blocks flagged supported categories but is not exhaustive image screening. Keep photo privacy guidance and specialist review.
- A specialist can review feasibility and provide any quote using the authoritative catalog and production team. The AI never invents a price or accepts an order.
- The brand and product owners approve logo, hero image, optional sofa references, product descriptions, and rights for media used on the live route. The team verifies that a customer can download a result, reach a specific specialist contact path, and share the concept manually without assuming an automatic lead handoff.
- The owner has set the OpenAI project hard limit and spend alerts, bought prepaid credits, and left auto-recharge off. IP allowlisting, the production WAF rule, and delivery of log alerts remain launch gates for the integration team.

## What the team receives

Standalone source, lockfile, two optional sofa reference images, official brand imagery, five generated concept-card images, an offline fictional kitchen comparison, a saved protected local API result, the environment template, security tests, and the setup runbooks in `README.md` and `scripts/local-e2e/README.md`. No credentials are included. Local typecheck, tests, production build, a direct provider smoke test, and protected local API edits passed. The real Cloudflare WAF/Turnstile, Upstash, live site, catalog and advisor integration still require staging. This is a handoff package, not a live deployment.
