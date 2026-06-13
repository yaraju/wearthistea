# wearthistea — Project Prompt (v2)

Use this as the Project Instructions for a new Claude Project. It captures all decisions made so far.

---

## What We're Building

**wearthistea.com** — a print-on-demand (POD) t-shirt brand that turns internet gossip, drama, and "tea" into original AI-generated t-shirt designs. The brand name is a triple pun: *Wear This T* + *Spill the Tea* + gossip culture. Users submit a prompt (a piece of drama, a conversation, a moment), and the system generates 2–5 original t-shirt design options for human review. Once approved, the designs go live as Printify products and the user is emailed a link.

**This is Phase 1 — manual, local, zero-cost-first.** Social media bots and automation are Phase 2.

---

## Founder Context

- India-based founder with a US bank account (payments from Stripe go to the US account directly — no Wise or international transfer setup needed, already handled separately)
- Has an active **Google Gemini** subscription (includes **Imagen 3 / Nano Banana Pro** for high-res image generation — $0 additional cost)
- Domain: **wearthistea.com** (or wearthistea.ai — TBD)
- Hosting: **Netlify** (free tier CDN for frontend)

---

## Phase 1 Architecture (Zero-Cost-First)

### Stack

| Layer | Tool | Cost |
|---|---|---|
| Frontend, Backend | Netlify (Node based whatever you are best at) | Free |
| LLM | Claude Pro (via Claude.ai API or direct prompting) | Existing subscription |
| Image generation | Google Gemini / Imagen 3 (Nano Banana Pro) | Existing subscription |
| POD fulfillment | Printify (free plan) | Free |
| Payments | Stripe (US bank account) | 2.9% + 30¢/transaction |
| Auth / Login | Keep it open to start with later in the project will integrate Google OAuth, GitHub OAuth, or Magic Link email, manual registration with verification etc and with admin profile | Free tier |
| Email delivery | Resend | Free |
| Database | postgresql neon dont use neon auth | Free |
| Social media scraping (Phase 2) | Apify | ~$5–$49/month |


## Design Specification

Each design consists of two components:

### A. Text Element
- A punchy, witty, quotable phrase derived from the tea/drama
- Should work as a standalone joke or cultural reference
- Font and placement: bold, readable at a distance
- Must NOT be a direct verbatim quote from a copyrighted song/script

### B. Character / Visual Element (when applicable)
- If the drama involves a specific real or fictional individual:
  - Generate a **line-art style illustration** — stylized, slightly abstracted
  - Should NOT be photo-realistic or easily mistaken for the real person
  - Should be recognizable **by association** to anyone who knows the context (signature silhouette, characteristic accessory, iconic pose) — not by photographic likeness
  - Examples: a person famous for a specific hairstyle → exaggerated line-art of that hairstyle; a celebrity known for a specific gesture → caricature-style abstraction of that gesture
  - Think: editorial cartoon aesthetic, not portrait

### Print Specifications
- Final image: **4500 × 5400 px, 300 DPI**
- Format: PNG with transparent background
- Color mode: RGB
- No bleed required (Printify handles that)

### Preferred Blank (t-shirt)
- **Bella+Canvas 3001** (unisex, super soft, great print quality)
- **Next Level 3600** (alternative, also premium soft)
- Offer: S, M, L, XL, 2XL minimum

---

## Printify Integration

- Free Printify account
- API: `https://api.printify.com/v1/`
- After human approval:
  1. POST `/shops/{shop_id}/uploads/images.json` — upload design image
  2. POST `/shops/{shop_id}/products.json` — create product with variants
  3. POST `/shops/{shop_id}/products/{product_id}/publish.json` — publish to storefront
- Store Printify product URL → include in email to user



## Admin Dashboard (Local, Phase 1)

A simple local web UI (can be a basic HTML page served by the same backend) that shows:
- Queue of pending design batches
- For each batch: the original user prompt + generated images + suggested titles/copy
- Approve / Reject buttons per design (and per batch)
- Status of Printify upload

This is intentionally low-tech for Phase 1 — no auth required since it only runs locally.

