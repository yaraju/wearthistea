// Discovery script for GET /api/external/orders/{id} — Printrove's public
// docs (https://api.printrove.com/docs/) confirm this endpoint exists but
// don't document its response schema. Run this against a REAL
// printroveOrderId (from an existing Order.printroveOrderId in the DB) to
// see the raw response and correct src/lib/printrove.ts's getOrderStatus
// field-name guesses and src/lib/printrove-status.ts's RAW_TO_SIMPLIFIED
// lookup table accordingly. Read-only — no order is created or mutated.
//
// Usage: npx tsx scripts/test-order-status.ts <printroveOrderId>
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const printroveOrderId = process.argv[2];
  if (!printroveOrderId) {
    console.error("Usage: npx tsx scripts/test-order-status.ts <printroveOrderId>");
    console.error(
      "Find one via: SELECT id, \"printroveOrderId\" FROM \"Order\" WHERE \"printroveOrderId\" IS NOT NULL;"
    );
    process.exit(1);
  }

  const { getOrderStatus } = await import("../src/lib/printrove");

  console.log(`Fetching live status for Printrove order ${printroveOrderId}...`);
  try {
    const status = await getOrderStatus(printroveOrderId);
    console.log("Parsed (with current field-name guesses):", JSON.stringify(status, null, 2));
    console.log(
      "\nIf `raw` is null, or trackingUrl/courierName/deliveredAt look wrong, the raw " +
        "response's actual field names differ from the guesses in printrove.ts#getOrderStatus " +
        "— re-run with a temporary console.log(order) inside that function to see the real JSON."
    );
  } catch (err) {
    console.error("Fetch failed:", err);
  }
}

main();
