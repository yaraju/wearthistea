import { FulfillInput } from "../src/lib/print-provider";
import dotenv from "dotenv";
dotenv.config();
console.log("PRINTROVE_PRODUCT_ID:", process.env.PRINTROVE_PRODUCT_ID);
console.log("PRINTROVE_PRODUCT_SUBTYPE_ID:", process.env.PRINTROVE_PRODUCT_SUBTYPE_ID);

async function main() {
  const { fulfill } = await import("../src/lib/printrove");
  const createOrder = process.argv.includes("--order");
  
  console.log(`Starting test fulfillment (createOrder: ${createOrder})`);
  
  // A tiny 1x1 transparent PNG
  const sampleDesign = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
  
  const input = {
    referenceNumber: "TEST-" + Date.now(),
    title: "Test Design " + new Date().toISOString(),
    description: "A test design uploaded via script",
    designBase64: sampleDesign,
    designFileName: "test-design.png",
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
