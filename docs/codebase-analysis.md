# Codebase Analysis: wearthistea

## Summary

The codebase for `wearthistea` is an advanced e-commerce platform specialized in Print-on-Demand (POD) merchandise, heavily leveraging generative AI (Google Gemini) for design creation and product listing automation across multiple fulfillment providers.

### 1. Project Structure and Main Modules

The project follows a standard Next.js App Router structure (`src/app`, `src/components`) complemented by specialized library modules for business logic, configuration, and utility scripts.

| Module | Location | Purpose / Role |
| :--- | :--- | :--- |
| **Core Logic** | `src/lib` | Houses reusable application libraries: `print-provider.ts` (the central fulfillment abstraction layer), `printrove.ts`, `printify.ts` (implementations for specific POD services), `storage.ts`, `prisma.ts`, and `mockup.ts`. |
| **Configuration** | `src/config` | Manages all application settings, including API keys (implicitly via `.env`), AI model parameters (`settings.ts`), and prompt templates (`prompts.ts`). Crucial for decoupling environment-specific logic from code. |
| **Frontend UI** | `src/app`, `src/components` | Contains the user interface components and routes: `/`, `/admin`, legal pages (`/legal/*`), and core widgets like `<KeywordStudio />`. |
| **API Endpoints** | `src/app/api` | Handles server-side logic for webhooks or form submissions. Includes dedicated endpoints for image generation, design selection, health checks, and administrative actions (e.g., rejecting designs). |
| **Database Schema** | `prisma/schema.prisma` | Defines the data model used by Prisma ORM, suggesting local state management for products, users, or generated assets. |
| **Utilities & Scripts** | `scripts/` | Dedicated scripts (`test-fulfillment.ts`, `discover-printrove-variants.mjs`, etc.) designed for background tasks, testing the fulfillment pipeline, and data backfilling. |
| **Environment** | `.env.*` | Configuration files govern provider selection, pricing, model parameters, and catalog IDs (e.g., `PRINTROVE_PRODUCT_ID`). |

### 2. Core Functionalities Implemented

The application is built around a sophisticated workflow that connects AI creativity to physical product fulfillment.

#### A. Generative Design & Content Pipeline (AI Core)
- **Concept Generation:** The system uses the Gemini API (`@google/genai`) via `src/lib/gemini.ts` and configuration parameters in `settings.ts` (e.g., `textTemperature`) to generate creative ideas, titles, and descriptive concepts based on keywords.
- **Image Rendering:** It renders high-resolution PNG designs using the AI's image model (`imageModel`), fulfilling the "Design Upload" guideline by producing print-ready art.
- **Mockup Generation (Optional):** The system has logic to optionally composite these raw designs onto product mockups (`generateProductShot`) for a rich grid preview experience, while retaining the raw design file for actual printing.

#### B. E-commerce and Fulfillment Workflow (POD Core)
- **Provider Abstraction:** `src/lib/print-provider.ts` is the most critical piece of architecture, defining a standardized `PrintProvider` interface (`options()` and `fulfill(input: FulfillInput)`). This allows the system to switch between Printify and PrintRove seamlessly using environment variables (`PRINT_PROVIDER`).
- **Product Mapping:** It handles complex provider-specific requirements.
  - **Printify:** Uses blueprint queries (e.g., `blueprintQuery`) and fixed price points in cents (`priceCents`) for direct integration into the sales channel.
  - **PrintRove:** Requires explicit mapping of variant IDs via `PRINTROVE_VARIANT_MAP` to ensure that a customer's size/color selection correctly maps to an active, printable SKU on PrintRove's side.
- **Order Fulfillment:** The core action is the `fulfill()` method, which takes structured data (`FulfillInput`) including design base64, price, quantity, and recipient details, to either create a product listing or place a final order via the connected POD API.

#### C. Administrative & Operational Features
- **Admin Panel:** Dedicated routes (`/admin`, `/api/admin/reject`) suggest administrative capabilities for reviewing, approving, or rejecting AI-generated designs before they go live (a critical gatekeeping function).
- **Data Management:** Prisma integration suggests persistence of generated assets and product metadata.
- **Utility Scripts:** The presence of scripts like `test-fulfillment.ts` and `discover-printrove-variants.mjs` indicates robust testing mechanisms designed to verify the entire end-to-end pipeline (design upload → product creation → order placement) without live transactions.

## Recommendations for Improvement

### 1. Payment Gateway Integration
The current workflow focuses on *fulfillment* (creating the listing/order) but the actual *payment capture* mechanism is not explicitly detailed beyond `cod: boolean` in settings. Implementing a full Stripe/PayPal integration would make this platform ready for direct payment collection, rather than relying solely on Cash-on-Delivery (COD).

### 2. Error Handling and Retries
The fulfillment APIs (Printify/PrintRove) are prone to rate limits or temporary failures. Robust implementation of exponential backoff and retry logic within `src/lib/print-provider.ts` would significantly increase reliability.

### 3. Variant Logic Centralization
While PrintRove's variant mapping is handled, the overall size/color validation should be centralized. If a user selects an option (e.g., "Green", "XXL") that doesn't exist in *any* configured `variantMap`, the frontend experience needs clearer feedback than just failing fulfillment.

### 4. Contextual Prompt Management
The system relies on fixed prompts (`src/config/prompts.ts`). Implementing a structured way to manage prompt versions and A/B test different prompting strategies based on product category or design style would allow for continuous improvement of the AI's output quality.

### 5. Missing External Integrations

| Integration | Rationale |
| :--- | :--- |
| **Inventory Management (IMS)** | Necessary for tracking physical stock levels if printed items are also sold elsewhere. |
| **Analytics Platform** | Google Analytics or similar needed to monitor conversion funnels, popular keywords, and design performance metrics. |
| **Email/Notification Service** | A dedicated service (e.g., SendGrid) should be implemented for order confirmations, tracking updates, and design approval notifications. |

### 6. Technical Dependencies to Verify
- **TypeScript Strictness:** Ensure all modules use the latest strict TypeScript features to catch potential runtime errors from dynamic configuration loading (e.g., in `settings.ts`).
- **Rate Limiting Guards:** Explicitly implement circuit breakers or rate limit guards around all calls to external APIs (`@google/genai`, Printify, PrintRove) within `src/lib/print-provider.ts` and API routes.
