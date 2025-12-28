import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const SHOP = process.env.SHOP; // a0pyr1-ce.myshopify.com
const ADMIN_TOKEN = process.env.ADMIN_TOKEN; // shpat_...
const API_VER = "2025-04";

/**
 * Health check (so Render shows "Live")
 */
app.get("/", (_req, res) => {
  res.status(200).send("OK");
});

/**
 * App Proxy endpoint (Shopify will forward /apps/customization-request here)
 */
app.post("/proxy/customization-request", async (req, res) => {
  try {
    if (!SHOP || !ADMIN_TOKEN) {
      return res.status(500).json({ error: "Missing SHOP or ADMIN_TOKEN env vars" });
    }

    const { phone, product, customer } = req.body || {};
    if (!phone || !product?.title || !product?.url) {
      return res.status(400).json({ error: "Missing phone or product data" });
    }

    const isLoggedIn = !!customer?.logged_in;

    const noteLines = [
      "Customization request",
      `Product: ${product.title}`,
      `Link: ${product.url}`,
      `Phone: ${phone}`,
      isLoggedIn
        ? `Customer: ${(customer.first_name || "").trim()} ${(customer.last_name || "").trim()} | ${customer.email || ""}`
        : "Customer: Guest (not logged in)"
    ];

    const draftInput = {
      tags: ["Customization request"],
      note: noteLines.join("\n"),
      // optional "request item" at $0 so it's visible in the draft
      lineItems: [
        {
          title: `Customization request - ${product.title}`,
          quantity: 1,
          originalUnitPrice: "0.00",
          customAttributes: [
            { key: "Type", value: "Customization request" },
            { key: "Product", value: product.title },
            { key: "Product URL", value: product.url },
            { key: "Phone", value: phone }
          ]
        }
      ]
    };

    // Attach email for logged-in customers (helps the draft display customer context)
    if (isLoggedIn && customer?.email) {
      draftInput.email = customer.email;
    }

    const query = `
      mutation draftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id name }
          userErrors { field message }
        }
      }
    `;

    const resp = await fetch(`https://${SHOP}/admin/api/${API_VER}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": ADMIN_TOKEN
      },
      body: JSON.stringify({ query, variables: { input: draftInput } })
    });

    const json = await resp.json();
    const result = json?.data?.draftOrderCreate;

    if (result?.userErrors?.length) {
      return res.status(400).json({ error: result.userErrors[0].message });
    }

    return res.status(200).json({ ok: true, draft_name: result?.draftOrder?.name });
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
