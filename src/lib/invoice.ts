import PDFDocument from "pdfkit";
import { prisma } from "./prisma";
import { saveFile } from "./storage";
import { settings } from "@/config/settings";

// Knitted cotton/blend t-shirts — the only thing we sell, so this is fixed
// rather than looked up per category.
const HSN_CODE = "6109";

/** Post-GST-2.0 (Sept 2025) apparel slab: 5% at/under ₹2,500/piece, 18% above. */
function gstRateFor(unitPrice: number): number {
  return unitPrice <= 2500 ? 0.05 : 0.18;
}

function financialYear(d: Date): string {
  const y = d.getFullYear();
  const fyStart = d.getMonth() >= 3 ? y : y - 1; // April (month 3, 0-indexed) starts the FY
  return `${fyStart}-${String((fyStart + 1) % 100).padStart(2, "0")}`;
}

/** Atomically claim the next sequential invoice number — GST rules require
 * strictly consecutive numbering, so this can't be derived from a
 * timestamp or id (concurrent requests could easily produce gaps or
 * out-of-order numbers that way). */
async function nextInvoiceNumber(date: Date): Promise<string> {
  const counter = await prisma.counter.upsert({
    where: { key: "invoice" },
    create: { key: "invoice", value: 1 },
    update: { value: { increment: 1 } },
  });
  return `INV-${financialYear(date)}-${String(counter.value).padStart(6, "0")}`;
}

interface GstBreakdown {
  unitPrice: number;
  quantity: number;
  totalInclusive: number;
  taxableValue: number;
  gstRate: number;
  gstAmount: number;
  /** true = buyer and seller are in the same state (CGST+SGST); false = IGST. */
  intraState: boolean;
  cgst: number;
  sgst: number;
  igst: number;
}

function computeGst(unitPrice: number, quantity: number, buyerState: string | null): GstBreakdown {
  const gstRate = gstRateFor(unitPrice);
  const totalInclusive = unitPrice * quantity;
  // GST-inclusive price: taxable value is back-calculated, not added on top.
  const taxableValue = totalInclusive / (1 + gstRate);
  const gstAmount = totalInclusive - taxableValue;

  // Buyer state unknown: can't confirm place of supply, so this shouldn't
  // silently guess intra-state (that's the branch that halves the rate per
  // line — the wrong guess understates tax due). Treat as inter-state.
  const intraState = Boolean(
    buyerState && buyerState.trim().toLowerCase() === settings.seller.state.trim().toLowerCase()
  );

  return {
    unitPrice,
    quantity,
    totalInclusive,
    taxableValue,
    gstRate,
    gstAmount,
    intraState,
    cgst: intraState ? gstAmount / 2 : 0,
    sgst: intraState ? gstAmount / 2 : 0,
    igst: intraState ? 0 : gstAmount,
  };
}

function rupees(n: number): string {
  return `Rs. ${n.toFixed(2)}`;
}

function renderPdf(opts: {
  invoiceNumber: string;
  invoiceDate: Date;
  orderId: string;
  description: string;
  buyer: {
    name: string;
    address1: string;
    address2?: string | null;
    city?: string | null;
    state?: string | null;
    pincode?: string | null;
    country: string;
  };
  breakdown: GstBreakdown;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const { seller } = settings;
    const { breakdown: b } = opts;

    doc.fontSize(18).font("Helvetica-Bold").text(seller.businessName);
    doc.fontSize(9).font("Helvetica").text(seller.address);
    doc.text(`GSTIN: ${seller.gstin}`);
    doc.moveDown(1);

    doc.fontSize(14).font("Helvetica-Bold").text("TAX INVOICE", { align: "right" });
    doc.fontSize(9).font("Helvetica");
    doc.text(`Invoice No: ${opts.invoiceNumber}`, { align: "right" });
    doc.text(`Invoice Date: ${opts.invoiceDate.toLocaleDateString("en-IN")}`, { align: "right" });
    doc.text(`Order Ref: ${opts.orderId}`, { align: "right" });
    doc.moveDown(1);

    doc.fontSize(10).font("Helvetica-Bold").text("Bill To / Ship To");
    doc.font("Helvetica").fontSize(9);
    doc.text(opts.buyer.name);
    doc.text(opts.buyer.address1);
    if (opts.buyer.address2) doc.text(opts.buyer.address2);
    doc.text(
      [opts.buyer.city, opts.buyer.state, opts.buyer.pincode].filter(Boolean).join(", ")
    );
    doc.text(opts.buyer.country);
    doc.moveDown(1.5);

    // ── Line-item table ──────────────────────────────────────────────────
    const tableTop = doc.y;
    const cols = { desc: 50, hsn: 250, qty: 300, rate: 335, taxable: 390, gst: 450, total: 500 };
    doc.font("Helvetica-Bold").fontSize(8);
    doc.text("Description", cols.desc, tableTop);
    doc.text("HSN", cols.hsn, tableTop);
    doc.text("Qty", cols.qty, tableTop);
    doc.text("Rate", cols.rate, tableTop);
    doc.text("Taxable", cols.taxable, tableTop);
    doc.text("GST", cols.gst, tableTop);
    doc.text("Total", cols.total, tableTop);
    doc.moveTo(50, tableTop + 14).lineTo(545, tableTop + 14).stroke();

    const rowY = tableTop + 20;
    doc.font("Helvetica").fontSize(8);
    doc.text(opts.description.slice(0, 45), cols.desc, rowY, { width: 195 });
    doc.text(HSN_CODE, cols.hsn, rowY);
    doc.text(String(b.quantity), cols.qty, rowY);
    doc.text(b.unitPrice.toFixed(2), cols.rate, rowY);
    doc.text(b.taxableValue.toFixed(2), cols.taxable, rowY);
    doc.text(`${(b.gstRate * 100).toFixed(0)}%`, cols.gst, rowY);
    doc.text(b.totalInclusive.toFixed(2), cols.total, rowY);
    doc.moveTo(50, rowY + 20).lineTo(545, rowY + 20).stroke();

    // ── Tax breakdown ────────────────────────────────────────────────────
    let y = rowY + 35;
    doc.font("Helvetica").fontSize(9);
    doc.text(`Taxable Value: ${rupees(b.taxableValue)}`, 350, y, { align: "right", width: 195 });
    y += 14;
    if (b.intraState) {
      doc.text(`CGST (${((b.gstRate / 2) * 100).toFixed(1)}%): ${rupees(b.cgst)}`, 350, y, { align: "right", width: 195 });
      y += 14;
      doc.text(`SGST (${((b.gstRate / 2) * 100).toFixed(1)}%): ${rupees(b.sgst)}`, 350, y, { align: "right", width: 195 });
      y += 14;
    } else {
      doc.text(`IGST (${(b.gstRate * 100).toFixed(0)}%): ${rupees(b.igst)}`, 350, y, { align: "right", width: 195 });
      y += 14;
    }
    doc.font("Helvetica-Bold");
    doc.text(`Grand Total: ${rupees(b.totalInclusive)}`, 350, y, { align: "right", width: 195 });
    y += 30;

    doc.font("Helvetica").fontSize(7).fillColor("#666");
    doc.text(
      "This is a computer-generated invoice. Place of supply: " +
        (opts.buyer.state || "unknown") +
        ".",
      50,
      y
    );

    doc.end();
  });
}

/**
 * Generate a GST-compliant tax invoice PDF for an Order and store it,
 * setting Order.invoiceNumber/invoiceUrl. Idempotent: an Order that already
 * has an invoiceNumber is returned as-is rather than issuing a second one
 * (a real invoice number, once issued, must never be reissued/reused).
 */
export async function generateInvoice(orderId: string): Promise<{ invoiceNumber: string; invoiceUrl: string }> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { design: true },
  });
  if (!order) throw new Error(`Order ${orderId} not found.`);
  if (order.invoiceNumber && order.invoiceUrl) {
    return { invoiceNumber: order.invoiceNumber, invoiceUrl: order.invoiceUrl };
  }
  if (!order.recipientName || !order.addressLine1 || !order.country) {
    throw new Error(`Order ${orderId} has no recipient/address — can't invoice it.`);
  }

  const unitPrice = order.unitPriceCents ?? 0;
  const quantity = order.quantity ?? 1;
  const breakdown = computeGst(unitPrice, quantity, order.state);

  const invoiceDate = new Date();
  const invoiceNumber = await nextInvoiceNumber(invoiceDate);

  const pdf = await renderPdf({
    invoiceNumber,
    invoiceDate,
    orderId: order.id,
    description: order.design.title,
    buyer: {
      name: order.recipientName,
      address1: order.addressLine1,
      address2: order.addressLine2,
      city: order.city,
      state: order.state,
      pincode: order.pincode,
      country: order.country,
    },
    breakdown,
  });

  const invoiceUrl = await saveFile(`invoices/${invoiceNumber}.pdf`, pdf, "application/pdf");

  await prisma.order.update({
    where: { id: orderId },
    data: {
      invoiceNumber,
      invoiceUrl,
      gstRateBps: Math.round(breakdown.gstRate * 10000),
      gstAmountCents: Math.round(breakdown.gstAmount),
    },
  });

  return { invoiceNumber, invoiceUrl };
}
