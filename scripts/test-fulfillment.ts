import { FulfillInput } from "../src/lib/print-provider";
import dotenv from "dotenv";
dotenv.config();
console.log("PRINTROVE_PRODUCT_ID:", process.env.PRINTROVE_PRODUCT_ID);
console.log("PRINTROVE_PRODUCT_SUBTYPE_ID:", process.env.PRINTROVE_PRODUCT_SUBTYPE_ID);

async function main() {
  const { fulfill } = await import("../src/lib/printrove");
  const createOrder = process.argv.includes("--order");
  
  console.log(`Starting test fulfillment (createOrder: ${createOrder})`);

  // A small opaque square on a transparent canvas — big enough for
  // trimDesign()'s trim() step (which needs a real content bounding box,
  // not a 1x1 pixel) to actually exercise the trim/fit-to-frame logic.
  const sharp = (await import("sharp")).default;
  const sampleDesign = (
    await sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: await sharp({ create: { width: 100, height: 100, channels: 4, background: { r: 220, g: 20, b: 60, alpha: 1 } } }).png().toBuffer(), left: 100, top: 100 }])
      .png()
      .toBuffer()
  ).toString("base64");

  const input = {
    referenceNumber: "TEST-" + Date.now(),
    title: "Test Design " + new Date().toISOString(),
    description: "A test design uploaded via script",
    designBase64: sampleDesign,
    designFileName: "test-design.png",
    // Same sample PNG reused for the back placement — this is only testing
    // that the front+back upload/placement wiring works end to end, not
    // real back artwork (see back-design.ts for actual back-print rendering).
    backDesignBase64: sampleDesign,
    backDesignFileName: "test-design-back.png",
    backLayout: "upper-back",
    priceCents: 1000,
    quantity: 1,
    variant: { size: "M", color: "Black" },
    customer: createOrder ? {
      name: "Junie Test",
      email: "test@example.com",
      phone: "9999999999",
      address1: "123 Test Street",
      city: "Bangalore",
      state: "Karnataka",
      pincode: "560001",
      country: "India"
    } : null,
    cod: true
  };

  try {
    const result = await fulfill(input as FulfillInput);
    console.log("Fulfillment result:", JSON.stringify(result, null, 2));
    
    if (result.productId) {
        console.log("SUCCESS: Design uploaded and product created.");
    }
    if (createOrder && result.orderId) {
        console.log("SUCCESS: Order placed.");
    } else if (createOrder) {
        console.log("FAILURE: Order was requested but no orderId returned.");
    }
  } catch (error) {
    console.error("Fulfillment failed:", error);
  }
}

main();
