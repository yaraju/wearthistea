/**
 * Design-judge module: the core quality checks that apply to every judge
 * run, live or bulk — does the rendered artwork's ink actually work against
 * its claimed garment color, and is there a garment/mockup drawn into what's
 * supposed to be isolated, transparent print art (issue #12).
 *
 * Bulk-only checks (integrity audit, style re-check, stuck-generation
 * sweep) are a separate module — see issue #17.
 *
 * judgeDesign() is a pure function: design fields + image bytes + claimed
 * color in, a JudgeVerdict out. No DB access, no side effects — callers own
 * persisting the verdict (issue #13's live judge task, issue #18's bulk
 * runner script both call this instead of each re-implementing the same
 * multimodal QA call).
 *
 * Builds on prompts.imageReview() (src/config/prompts.ts), an existing
 * multimodal QA prompt whose call shape was already proven by
 * scripts/eval-designs.ts (generateContent + inlineData image + JSON
 * schema + temperature: 0) — including the hard-won lesson that the vision
 * model can't reliably perceive alpha/pixel values, so its claims about the
 * image alone shouldn't be trusted (eval-designs.ts's "background not
 * transparent" false-claim check). The color-fitness question here is
 * grounded the same way: measureInkLuminance() (gemini.ts) measures the
 * real non-transparent ink pixels with sharp, and the light/dark verdict is
 * computed in TypeScript — not left for the model to reason about — before
 * being handed to the model as a plain conclusion in the prompt.
 */
import type { Design } from "@prisma/client";
import { ai, measureInkLuminance } from "./gemini";
import { prompts } from "@/config/prompts";
import { settings } from "@/config/settings";
import { withModelFallback } from "./gemini-resilient";

export type JudgeFix =
  "none" | "relabel" | "invert-ink" | "rerun-bg-removal" | "regenerate";

const FIX_VALUES: readonly JudgeFix[] = [
  "none",
  "relabel",
  "invert-ink",
  "rerun-bg-removal",
  "regenerate",
];

function isJudgeFix(value: unknown): value is JudgeFix {
  return (
    typeof value === "string" &&
    (FIX_VALUES as readonly string[]).includes(value)
  );
}

export interface JudgeVerdict {
  /** False when the artwork is structurally unusable — e.g. a garment/
   * mockup is drawn into the print graphic, the phrase is illegible/
   * missing, or important art is cropped. */
  usable: boolean;
  /** Human-readable QA findings from the model, e.g. "t-shirt collar drawn
   * into the graphic". */
  issues: string[];
  /** Whether this design should be regenerated from scratch (distinct from
   * `usable` — a design can be usable=false for a reason a cheap fix
   * resolves, e.g. a relabel/invert-ink color mismatch, without needing a
   * full regeneration). */
  needsRegeneration: boolean;
  /** Concise corrected prompt to use if `needsRegeneration` is true. */
  regenerationPrompt: string;
  /** Whether the ink's actual light/dark direction works against the
   * claimed garment color (light ink on Black, dark ink on White) — the
   * garment-color judge bug this module exists to catch. */
  colorMatchesArt: boolean;
  /** What to actually do about it. "none" when nothing needs fixing;
   * "relabel"/"invert-ink" are cheap programmatic fixes for a color
   * mismatch (see prompts.imageReview()'s doc comment for when each
   * applies, particularly the raster-vs-svg distinction); "rerun-bg-
   * removal" for a transparency problem; "regenerate" when nothing short
   * of a full re-render fixes it. */
  fix: JudgeFix;
  /** Ground-truth mean luminance (0-255) of the artwork's non-transparent
   * ink pixels, measured programmatically (gemini.ts's measureInkLuminance)
   * — not the model's guess. Null when the image has no non-transparent
   * pixels at all. Returned for downstream logging/debugging (e.g.
   * Design.validationNotes). */
  measuredInkLuminance: number | null;
}

/** The subset of a Design row judgeDesign() needs. `style` decides whether
 * "relabel" is a safe fix (see prompts.imageReview()'s doc comment) —
 * callers can pass a full Design row, or any object with at least these
 * three fields (e.g. a freshly-generated Concept before it's persisted). */
export type JudgeableDesign = Pick<
  Design,
  "phrase" | "visualConcept" | "style"
>;

/**
 * Judge one rendered design's artwork. Calls Gemini for real (the same
 * multimodal QA call shape scripts/eval-designs.ts already proved) — no
 * offline/no-API-key fallback here, unlike gemini.ts's generation helpers:
 * a judge that silently "passes" everything when GEMINI_API_KEY is unset
 * would be a false-validate that a bulk runner could write to every row.
 * Callers without a key should catch and handle the thrown error instead.
 */
export async function judgeDesign(
  design: JudgeableDesign,
  imageB64: string,
  claimedColor: "Black" | "White",
): Promise<JudgeVerdict> {
  const measuredInkLuminance = await measureInkLuminance(imageB64);

  // Direction is computed here, in TypeScript, from the actual pixels — not
  // left for the vision model to reason about from a luminance number
  // paired with a claimed color, which is exactly the kind of "ignores/
  // contradicts the instruction" reasoning failure that motivated this
  // whole module (see project memory: design-judge-color-bug).
  const luminanceHint =
    measuredInkLuminance === null
      ? "no non-transparent ink pixels were found in the artwork"
      : (() => {
          const reads = measuredInkLuminance > 127.5 ? "light" : "dark";
          const wants = claimedColor === "Black" ? "light" : "dark";
          const direction =
            reads === wants
              ? "MATCHES the claimed color's needed ink direction"
              : "MISMATCHES the claimed color's needed ink direction";
          return `measured ${measuredInkLuminance.toFixed(1)}/255 -> reads as ${reads} ink; claimed color is ${claimedColor}, which needs ${wants} ink; this ${direction}.`;
        })();

  const style: "raster" | "svg" = design.style === "svg" ? "svg" : "raster";

  const { value: res } = await withModelFallback(
    settings.gemini.textModel,
    (model) =>
      ai().models.generateContent({
        model,
        contents: [
          {
            role: "user",
            parts: [
              {
                text: prompts.imageReview(
                  design,
                  claimedColor,
                  luminanceHint,
                  style,
                ),
              },
              { inlineData: { mimeType: "image/png", data: imageB64 } },
            ],
          },
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: prompts.imageReviewSchema as unknown as Record<
            string,
            unknown
          >,
          temperature: 0,
        },
      }),
    { backupModel: settings.gemini.textBackupModel, label: "judgeDesign" },
  );

  const text = res.text;
  if (!text) throw new Error("Judge model returned no text.");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Judge model returned non-JSON: ${text.slice(0, 200)}…`);
  }

  const issues = Array.isArray(parsed.issues)
    ? parsed.issues.filter((i): i is string => typeof i === "string")
    : [];
  const usable =
    typeof parsed.usable === "boolean" ? parsed.usable : issues.length === 0;
  const needsRegeneration =
    typeof parsed.needsRegeneration === "boolean"
      ? parsed.needsRegeneration
      : !usable;
  const colorMatchesArt =
    typeof parsed.colorMatchesArt === "boolean" ? parsed.colorMatchesArt : true;
  const regenerationPrompt =
    typeof parsed.regenerationPrompt === "string"
      ? parsed.regenerationPrompt
      : "";
  const fix = isJudgeFix(parsed.fix)
    ? parsed.fix
    : needsRegeneration
      ? "regenerate"
      : colorMatchesArt
        ? "none"
        : "relabel";

  return {
    usable,
    issues,
    needsRegeneration,
    regenerationPrompt,
    colorMatchesArt,
    fix,
    measuredInkLuminance,
  };
}
