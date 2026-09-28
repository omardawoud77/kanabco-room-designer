# Send the Kanabco Room Designer to the development team

Copy the message below into your handoff. Attach this package and ask the team to use `HANDOFF.md` for product decisions and `README.md` for the implementation and security setup.

> Please integrate the attached Room Designer into the live Kanabco website. This is a standalone Next.js implementation, not a deployed feature or a change to our current price chatbot.
>
> Customers should upload one room photo and explore one of six ideas: sofa, bed and headboard, wardrobe, dresser, dressing room, or kitchen. They can choose a style, colour, and material direction, then see one AI image concept. Only the sofa flow may use an approved Kanabco product image as an optional reference. The other categories must remain exploratory ideas until our specialists confirm that we can make them.
>
> Do not show an instant price, claim that these categories are existing Kanabco products, or treat the image as a measured or buildable design. A specialist must confirm feasibility, dimensions, materials, scope, timing, and any quote. Keep the concept disclaimers visible before and after generation.
>
> Please connect the feature to our approved website route and advisor entry point, verify the two sofa reference images, and match the live brand. Preserve the server-side OpenAI call and all abuse controls. Keep `AI_FEATURE_ENABLED=false` until the staging and security checks below pass. Send us the staging URL, test evidence, expected cost per generation, and the remaining product decisions before public launch.

The source is in the **private** GitHub repository `omardawoud77/kanabco-room-designer`. This is a handoff location, not the live Kanabco site. Grant the development team access and integrate the package into the actual site repository after confirming its stack.

## Team checklist before public launch

1. **Integrate the live site:** Choose the route or subdomain, match the approved Kanabco brand, and connect the advisor contact path. The current package opens the homepage; it does not send a lead or store a customer photo.
2. **Confirm product claims:** Approve the two sofa images and descriptions. Keep beds, wardrobes, dressers, dressing rooms, and kitchens labeled as design concepts. Return `priceEgp: null` for every generated result until an approved pricing system is connected.
3. **Protect the API:** Keep `OPENAI_API_KEY` on the server. Configure Cloudflare WAF on the raw API path, Turnstile server verification, the trusted edge-secret header, origin protection, Upstash Redis limits, and the application kill switch. Test that a direct origin request fails.
4. **Limit the bill:** Use a dedicated OpenAI project and key, fixed server egress with key IP allowlisting, a project hard spend limit and alerts, prepaid credit with auto-recharge off, and the application's daily dollar cap. The owner chooses the dashboard hard-limit amount.
5. **Test in staging:** Run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build`; GitHub Actions also tests the atomic Lua guards against disposable Redis 7. Generate a representative concept for all six categories with a small test budget. Check output quality and cost. Inspect the provider response for `usage.input_tokens_details.image_tokens`, `usage.input_tokens_details.text_tokens`, and `usage.output_tokens`. If any is missing, the code stops new image calls until the next UTC day; resolve that mismatch before launch.
6. **Test abuse gates:** Confirm invalid tokens, token replay, oversize uploads, direct-origin requests, bursts, Redis failure, and `AI_FEATURE_ENABLED=false` block the paid image edit. Moderation checks the photo and fixed prompt against supported categories; it does not screen every private or unsafe visual detail.
7. **Review privacy and operations:** Publish the site's photo-processing notice and retention policy. Route `SPEND_SPIKE`, usage-breaker, and unsettled-call logs to a monitored alert. Scan source and deployed bundles for secrets. Confirm the hosting function supports the documented image timeout.

Keep the feature off if any security gate fails. The static `demo/index.html` shows the intended before/after interaction with fictional images; it does not exercise the API or demonstrate live model quality.
