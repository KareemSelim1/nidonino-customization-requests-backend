import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json());

/** ====== CONFIG (set these in Render env vars) ====== */
const SHOP = process.env.SHOP; // e.g. a0pyr1-ce.myshopify.com
const API_KEY = process.env.SHOPIFY_API_KEY; // Dev Dashboard Client ID
const API_SECRET = process.env.SHOPIFY_API_SECRET; // Dev Dashboard Secret
const SCOPES = process.env.SCOPES || "write_draft_orders,read_customers";
const HOST = process.env.HOST; // e.g. https://your-service.onrender.com
const API_VER = process.env.API_VER || "2025-04";

/** ====== TOKEN STORAGE (simple single-store) ====== */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, ".data");
const TOKEN_PATH = path.join(DATA_DIR, "token.json");

function saveToken(tokenObj) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokenObj, null, 2), "utf8");
}
function loadToken() {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  return JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
}

/** ====== HELPERS ====== */
function buildQueryString(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

// Verify Shopify HMAC for OAuth callback
function verifyHmac(query, secret) {
  const { hmac, ...rest } = query;
  if (!hmac) return false;

  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${Array.isArray(rest[key]) ? rest[key].join(",") : rest[key]}`)
    .join("&");

  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(digest, "utf8"), Buffer.from(hmac, "utf8"));
}

// (Optional) Verify App Proxy signature (recommended)
function verifyAppProxy(req, secret) {
  const q = { ...req.query };
  const signature = q.signature;
  delete q.signature;

  if (!signature) return false;

  const message = Object.keys(q)
    .sort()
    .map((k) => `${k}=${q[k]}`)
    .join("");

  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");
  return digest === signature;
}

/** ====== ROUTES ====== */
app.get("/", (_req, res) => res.status(200).send("OK"));

// Start OAuth
app.get("/auth", (req, res) => {
  if (!SHOP || !API_KEY || !HOST) {
    return res.status(500).send("Missing SHOP / SHOPIFY_API_KEY / HOST env vars");
  }

  const shop = req.query.shop || SHOP;
  const state = crypto.randomBytes(16).toString("hex");

  // store state in a cookie (simple approach)
  res.cookie?.("oauth_state", state, { httpOnly: true, sameSite: "lax" });

  const redirectUri = `${HOST}/auth/callback`;

  const installUrl =
    `https://${shop}/admin/oauth/authorize?` +
    buildQueryString({
      client_id: API_KEY,
      scope: SCOPES,
      redirect_uri: redirectUri,
      state,
    });

  res.redirect(installUrl);
});

// OAuth callback
app.get("/auth/callback", async (req, res) => {
  try {
    if (!API_SECRET || !API_KEY || !HOST || !SHOP) {
      return res.status(500).send("Missing env vars for OAuth");
    }

    // HMAC verify
    if (!verifyHmac(req.query, API_SECRET)) {
      return res.status(400).send("HMAC verification failed");
    }

    const { shop, code } = req.query;
    if (!shop || !code) return res.status(400).send("Missing shop or code");

    const tokenResp = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: API_KEY,
        client_secret: API_SECRET,
        code,
      }),
    });

    const tokenJson = await tokenResp.json();
    if (!tokenResp.ok) {
      return res.status(400).send(`Token exchange failed: ${JSON.stringify(tokenJson)}`);
    }

    // Save token for this store (single-store)
    saveToken({
      shop,
      access_token: tokenJson.access_token,
      scope: tokenJson.scope,
      created_at: new Date().toISOString(),
    });

    res.status(200).send("✅ App installed and token saved. You can close this tab.");
  } catch (e) {
    res.status(500).send(`Server error: ${String(e)}`);
  }
});

// App Proxy endpoint that your theme calls: /apps/customization-request
app.post("/proxy/customization-request", async (req, res) => {
  try {
    // Optional: verify app proxy signature (prevents random spam)
    if (process.env.VERIFY_PROXY === "true") {
      const ok = verifyAppProxy(req, API_SECRET);
      if (!ok) return res.status(401).json({ error: "Invalid proxy signature" });
    }

    const tok = loadToken();
    if (!tok?.access_token) {
      return res.status(401).json({ error: "App not installed / token missing. Visit /auth once." });
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
        : "Customer: Guest (not logged in)",
    ];

    const draftInput = {
      tags: ["Customization request"],
      note: noteLines.join("\n"),
      lineItems: [
        {
          title: `Customization request - ${product.title}`,
          quantity: 1,
          originalUnitPrice: "0.00",
          customAttributes: [
            { key: "Type", value: "Customization request" },
            { key: "Product", value: product.title },
            { key: "Product URL", value: product.url },
            { key: "Phone", value: phone },
          ],
        },
      ],
    };

    if (isLoggedIn && customer?.email) draftInput.email = customer.email;

    const query = `
      mutation draftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id name }
          userErrors { field message }
        }
      }
    `;

    const resp = await fetch(`https://${tok.shop}/admin/api/${API_VER}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": tok.access_token,
      },
      body: JSON.stringify({ query, variables: { input: draftInput } }),
    });

    const json = await resp.json();
    const result = json?.data?.draftOrderCreate;

    if (result?.userErrors?.length) {
      return res.status(400).json({ error: result.userErrors[0].message, raw: result.userErrors });
    }

    return res.status(200).json({ ok: true, draft_name: result?.draftOrder?.name });
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
