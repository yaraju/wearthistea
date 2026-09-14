/**
 * Automated validation for issue #15 — targeted image-to-image regeneration
 * (src/lib/design-regenerate.ts's buildRegenerationEdit(), src/lib/gemini.ts's
 * generateImageEdit()/renderConceptArtFix(), and their wiring into
 * design-render.ts's renderDesignArtwork(..., edit) / validation-chain.ts's
 * defaultRegenerateRenderFn()).
 *
 * Per this issue's own safety guidance, this script does NOT spend a real
 * Gemini call: renderConceptArtFix()'s `deps.generateEdit` injection point
 * (mirroring design-fixes.ts's deps.renderBack / deps.removeBg style) is
 * used to substitute a scripted fake edit model, so the FULL post-processing
 * pipeline (background removal, resolveGarmentColor's COLOR_CHOICE parsing)
 * still runs for real against real pixels — only the network call is faked.
 * The real-Gemini-call spot check against 2-3 live designs is this issue's
 * separate MANUAL validation step (see the issue's own comment thread for
 * before/after findings), not this script.
 *
 * Covers this issue's automated-validation criterion:
 *   "given a fixture 'before' image and a targeted instruction, the
 *   regenerated output is a real image (non-empty, valid PNG/transparent)
 *   and the flow correctly re-renders the back-print when the returned
 *   color differs from the design's prior variantColor."
 *
 * The second half of that criterion is checked as a NAMED INVARIANT, not a
 * conditional: design-render.ts's renderDesignArtwork() always re-renders
 * the back-print composite against the render's freshly-resolved
 * variantColor (never a stale `design.variantColor` read) — see that
 * function's own doc comment. That's structurally correct whether or not
 * THIS particular render happened to change the color, so what this script
 * actually proves is the INGREDIENT the invariant depends on: that
 * renderConceptArtFix()'s resolved variantColor really does flip to
 * whatever the edited image's own fresh COLOR_CHOICE line says, and that
 * feeding that fresh color into renderBackDesignArtwork() (exactly what
 * renderDesignArtwork() does) produces a back-print whose ink direction
 * matches the NEW color, not the design's prior one.
 *
 * Usage: npx tsx scripts/test-design-regenerate.ts
 * Exits non-zero if any assertion fails.
 */
import dotenv from "dotenv";
dotenv.config();

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  [${ok ? "ok" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const sharp = (await import("sharp")).default;
  const { buildRegenerationEdit } = await import("../src/lib/design-regenerate");
  const { renderConceptArtFix, resolveGarmentColor, measureInkLuminance } = await import("../src/lib/gemini");
  const { prompts, isDarkGarment } = await import("../src/config/prompts");
  const { renderBackDesignArtwork } = await import("../src/lib/back-design");
  const { judgeVerdictSchema } = await import("../src/lib/validation-chain");

  // ── Fixture builders ──────────────────────────────────────────────────
  /** A transparent canvas with one opaque `rgb` square in the middle — same
   * "ink" fixture shape test-design-fixes.ts/test-color-resolution.ts use. */
  async function inkSquareImage(rgb: { r: number; g: number; b: number }, size = 200): Promise<string> {
    const buf = await sharp({
      create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: await sharp({
            create: { width: size / 2, height: size / 2, channels: 4, background: { ...rgb, alpha: 1 } },
          })
            .png()
            .toBuffer(),
          left: Math.round(size / 4),
          top: Math.round(size / 4),
        },
      ])
      .png()
      .toBuffer();
    return buf.toString("base64");
  }

  async function transparentFraction(imageB64: string): Promise<number> {
    const { data, info } = await sharp(Buffer.from(imageB64, "base64")).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let transparent = 0;
    let total = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      total++;
      if (data[i + 3] < 16) transparent++;
    }
    return total === 0 ? 0 : transparent / total;
  }

  const concept = {
    title: "Test Design",
    phrase: "GROUP CHAT",
    visualConcept: "A bold speech bubble with ellipsis dots.",
    backPhrase: "",
    artStyle: "raster" as const,
  };

  // ── 1. buildRegenerationEdit() ──────────────────────────────────────────
  console.log("=== buildRegenerationEdit() ===");
  {
    const v = judgeVerdictSchema.parse({
      usable: false,
      issues: ["phrase reads 'GROPU CHAT' instead of 'GROUP CHAT'"],
      needsRegeneration: true,
      regenerationPrompt: "Fix the misspelled word 'GROPU' to correctly read 'GROUP'.",
      colorMatchesArt: true,
      fix: "regenerate",
      measuredInkLuminance: 200,
    });
    const edit = buildRegenerationEdit(v);
    check(
      "prefers verdict.regenerationPrompt verbatim (trimmed)",
      edit.instruction === "Fix the misspelled word 'GROPU' to correctly read 'GROUP'.",
      edit.instruction
    );
  }
  {
    const v = judgeVerdictSchema.parse({
      usable: false,
      issues: ["garment silhouette drawn into the graphic", "background not fully transparent"],
      needsRegeneration: true,
      regenerationPrompt: "",
      colorMatchesArt: true,
      fix: "regenerate",
      measuredInkLuminance: null,
    });
    const edit = buildRegenerationEdit(v);
    check(
      "falls back to verdict.issues when regenerationPrompt is empty",
      edit.instruction.includes("garment silhouette drawn into the graphic") && edit.instruction.includes("background not fully transparent"),
      edit.instruction
    );
  }
  {
    const v = judgeVerdictSchema.parse({
      usable: false,
      issues: [],
      needsRegeneration: true,
      regenerationPrompt: "",
      colorMatchesArt: true,
      fix: "regenerate",
      measuredInkLuminance: null,
    });
    const edit = buildRegenerationEdit(v);
    check("never returns an empty instruction, even with no prompt and no issues", edit.instruction.length > 0, edit.instruction);
  }

  // ── 2. prompts.designImageFix() ─────────────────────────────────────────
  console.log("\n=== prompts.designImageFix() ===");
  {
    const p = prompts.designImageFix(concept, "fix the misspelled word 'GROPU' to read 'GROUP'");
    check("embeds the targeted instruction", p.includes("fix the misspelled word 'GROPU' to read 'GROUP'"));
    check("embeds the phrase for context", p.includes("GROUP CHAT"));
    check('carries the MANDATORY RESPONSE FORMAT / COLOR_CHOICE block', p.includes("COLOR_CHOICE: black") && p.includes("COLOR_CHOICE: white"));
    check("is framed as an edit of the attached image, not a fresh illustration", /attached (reference )?image/i.test(p));
  }

  // ── 3. renderConceptArtFix() with an injected fake edit model ──────────
  console.log("\n=== renderConceptArtFix() (fake edit model, real post-processing) ===");
  {
    // Fixture "before" image: dark ink on transparent bg (as if drawn for a
    // White garment).
    const before = await inkSquareImage({ r: 20, g: 20, b: 20 });

    // Fake edit model: returns a DIFFERENT (light ink) fixture + a fresh
    // COLOR_CHOICE self-report of "black" — simulating a regeneration that
    // legitimately lands on the opposite garment color from the source.
    let calledWithPrompt = "";
    let calledWithImage = "";
    const fakeGenerateEdit = async (prompt: string, imageB64: string) => {
      calledWithPrompt = prompt;
      calledWithImage = imageB64;
      const after = await inkSquareImage({ r: 245, g: 245, b: 245 });
      return { imageB64: after, text: "COLOR_CHOICE: black" };
    };

    const result = await renderConceptArtFix(
      concept,
      before,
      "make the ink lighter so it reads clearly",
      undefined,
      (fn) => fn(),
      { generateEdit: fakeGenerateEdit }
    );

    check("dispatches to the injected edit model with the source image", calledWithImage === before);
    check("dispatches with a prompt built from designImageFix()", calledWithPrompt.includes("make the ink lighter so it reads clearly"));
    check("returns a non-empty imageB64", typeof result.imageB64 === "string" && result.imageB64.length > 0);

    // Valid PNG check — sharp throws on a corrupt/non-image buffer.
    const meta = await sharp(Buffer.from(result.imageB64, "base64")).metadata();
    check("output decodes as a valid PNG", meta.format === "png", JSON.stringify(meta));
    check("output has an alpha channel (transparent-background print graphic)", meta.hasAlpha === true);
    const transparency = await transparentFraction(result.imageB64);
    check("output has some transparent background remaining", transparency > 0, `${(transparency * 100).toFixed(1)}% transparent`);

    check('resolves the FRESH self-reported COLOR_CHOICE ("black"), not the source\'s prior color', result.variantColor === "Black", `got ${result.variantColor}`);
  }

  // ── 4. Standing rule ingredient: back-print re-renders against the NEW
  //      color, not the design's prior one ──────────────────────────────
  console.log("\n=== Back-print re-render uses the freshly-resolved color (design-render.ts's invariant) ===");
  {
    const priorVariantColor: "Black" | "White" = "Black";
    const backPhrase = "more tea behind me";

    // Simulate what renderConceptArtFix resolved for this regeneration —
    // the OPPOSITE of the design's prior color.
    const fakeGenerateEdit = async () => {
      const after = await inkSquareImage({ r: 15, g: 15, b: 15 }); // dark ink
      return { imageB64: after, text: "COLOR_CHOICE: white" };
    };
    const rendered = await renderConceptArtFix(concept, await inkSquareImage({ r: 240, g: 240, b: 240 }), "tidy up the edges", undefined, (fn) => fn(), {
      generateEdit: fakeGenerateEdit,
    });
    check("resolved color differs from the design's prior variantColor (the scenario this rule exists for)", rendered.variantColor !== priorVariantColor, `prior=${priorVariantColor} new=${rendered.variantColor}`);

    // This mirrors design-render.ts's renderDesignArtwork(): the back-print
    // call always uses the LOCAL freshly-resolved variantColor, never the
    // design row's (now-stale) prior value.
    const backB64 = await renderBackDesignArtwork(backPhrase, { layout: "upper-back", color: rendered.variantColor });
    const luminance = await measureInkLuminance(backB64);
    check("back-print render has measurable ink pixels", luminance !== null);
    if (luminance !== null) {
      const reads = luminance > 127.5 ? "light" : "dark";
      const wantsForNew = isDarkGarment(rendered.variantColor) ? "light" : "dark";
      const wantsForPrior = isDarkGarment(priorVariantColor) ? "light" : "dark";
      check(
        `back-print ink direction (${reads}) matches the NEW color's requirement (${wantsForNew}), not the prior color's (${wantsForPrior})`,
        reads === wantsForNew,
        `measured ${luminance.toFixed(1)}/255`
      );
    }
  }

  // ── 5. resolveGarmentColor() sanity re-check against this module's own
  //      fresh-COLOR_CHOICE text shape (guards against a copy/paste drift
  //      between generateImage()'s and generateImageEdit()'s text parsing —
  //      both funnel through the SAME resolveGarmentColor(), not a copy) ──
  console.log("\n=== resolveGarmentColor() shares the same parser for edit output ===");
  {
    const blank = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    check('edit-model text "COLOR_CHOICE: white" resolves to "White"', (await resolveGarmentColor("COLOR_CHOICE: white", blank)) === "White");
    check('edit-model text "COLOR_CHOICE: black" resolves to "Black"', (await resolveGarmentColor("COLOR_CHOICE: black", blank)) === "Black");
  }

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("ERROR", err);
  process.exitCode = 1;
});
