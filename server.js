import { timingSafeEqual, createHmac, randomBytes, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";
import { businessDetails } from "./data/business.js";
import { menuCategories, menuProducts } from "./data/menu.js";
import { initializeDatabase, listRecentOrders, saveOrder, validateOrderInput } from "./src/orders.js";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(projectRoot, "public");
const sessionCookie = "tsg_admin";
const sessionLifetimeSeconds = 30 * 60;

function safeEqual(left, right) {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function cookieValue(request, name) {
  const cookies = request.headers.cookie?.split(";") || [];
  const item = cookies.find((cookie) => cookie.trim().startsWith(`${name}=`));
  return item ? decodeURIComponent(item.trim().slice(name.length + 1)) : "";
}

function createSessionToken(secret, expiresAt) {
  const payload = `${expiresAt}.${randomBytes(24).toString("base64url")}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function validSessionToken(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  const [expiresAtText, nonce, signature, ...extra] = token.split(".");
  if (!expiresAtText || !nonce || !signature || extra.length || !/^\d+$/.test(expiresAtText)) {
    return false;
  }

  const expiresAt = Number(expiresAtText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowSeconds || expiresAt > nowSeconds + sessionLifetimeSeconds + 60) {
    return false;
  }

  const expected = createHmac("sha256", secret)
    .update(`${expiresAtText}.${nonce}`)
    .digest();
  const supplied = Buffer.from(signature, "base64url");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function configFromEnv(env) {
  return {
    menuConfirmed: env.MENU_CONFIRMED === "true",
    deliveryEnabled: env.DELIVERY_ENABLED === "true",
    deliveryServiceArea: env.DELIVERY_SERVICE_AREA || "",
    business: {
      ...businessDetails,
      phone: env.CONTACT_PHONE || businessDetails.phone,
      whatsapp: env.CONTACT_WHATSAPP || businessDetails.whatsapp,
      instagram: env.CONTACT_INSTAGRAM || businessDetails.instagram,
      location: env.BUSINESS_LOCATION || businessDetails.location,
      hours: env.BUSINESS_HOURS || businessDetails.hours,
      deliveryServiceArea: env.DELIVERY_SERVICE_AREA || ""
    }
  };
}

export function createApp({
  pool,
  env = process.env,
  serveStatic = true,
  products = menuProducts,
  categories = menuCategories
} = {}) {
  const app = express();
  const config = configFromEnv(env);
  config.menuConfirmed = config.menuConfirmed && products.every((product) => product.samplePrice === false);
  config.deliveryEnabled = config.deliveryEnabled && Boolean(config.deliveryServiceArea.trim());
  const loginAttempts = new Map();
  let databaseReady = false;

  app.disable("x-powered-by");
  app.set("case sensitive routing", true);
  app.set("trust proxy", 1);
  app.use((request, response, next) => {
    response.set("X-Content-Type-Options", "nosniff");
    response.set("Referrer-Policy", "strict-origin-when-cross-origin");
    response.set("X-Frame-Options", "DENY");
    next();
  });
  app.use("/api/admin", (_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "16kb", strict: true }));

  app.get("/healthz", (_request, response) => {
    response.status(databaseReady ? 200 : 503).json({ status: databaseReady ? "ok" : "starting" });
  });

  app.get("/api/menu", (_request, response) => {
    response.set("Cache-Control", "public, max-age=60");
    response.json({
      categories,
      products: products.map((product) => ({ ...product, isSample: product.samplePrice !== false })),
      sampleMenu: products.some((product) => product.samplePrice !== false),
      menuConfirmed: config.menuConfirmed
    });
  });

  app.get("/api/business", (_request, response) => {
    response.set("Cache-Control", "public, max-age=300");
    response.json({
      name: config.business.name,
      phone: config.business.phone,
      whatsapp: config.business.whatsapp,
      instagram: config.business.instagram,
      location: config.business.location,
      hours: config.business.hours,
      deliveryServiceArea: config.business.deliveryServiceArea,
      onlineOrderingEnabled: config.menuConfirmed && databaseReady,
      deliveryEnabled: config.deliveryEnabled
    });
  });

  app.post("/api/orders", async (request, response, next) => {
    if (!databaseReady || !pool) {
      return response.status(503).json({ error: "Online ordering is temporarily unavailable. Please contact the business directly." });
    }

    const idempotencyKey = request.get("Idempotency-Key") || "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
      return response.status(400).json({ error: "This order could not be verified. Please try submitting it again." });
    }

    const result = validateOrderInput(request.body, {
      products,
      menuConfirmed: config.menuConfirmed,
      deliveryEnabled: config.deliveryEnabled
    });
    if (result.error) {
      const status = config.menuConfirmed ? 400 : 503;
      return response.status(status).json({ error: result.error });
    }

    try {
      const order = await saveOrder(pool, result.order, idempotencyKey);
      response.set("Cache-Control", "no-store");
      return response.status(201).json({
        reference: order.reference,
        createdAt: order.createdAt,
        fulfillment: order.fulfillment,
        items: order.items,
        totalCents: order.totalCents
      });
    } catch (error) {
      return next(error);
    }
  });

  const requireAdmin = (request, response, next) => {
    const secret = env.ADMIN_SESSION_SECRET || "";
    const token = cookieValue(request, sessionCookie);
    if (!secret || !token || !validSessionToken(token, secret)) {
      response.set("Cache-Control", "no-store");
      return response.status(401).json({ error: "Please sign in to the order inbox." });
    }
    return next();
  };

  app.post("/api/admin/session", (request, response) => {
    const username = env.ADMIN_USERNAME || "";
    const password = env.ADMIN_PASSWORD || "";
    const secret = env.ADMIN_SESSION_SECRET || "";
    if (!username || !password || secret.length < 32) {
      return response.status(503).json({ error: "The order inbox has not been configured yet." });
    }

    const now = Date.now();
    for (const [ip, attempt] of loginAttempts) {
      if (now - attempt.startedAt > 15 * 60 * 1000) loginAttempts.delete(ip);
    }

    const ip = request.ip || "unknown";
    const attempt = loginAttempts.get(ip) || { startedAt: now, count: 0 };
    if (attempt.count >= 10) {
      return response.status(429).json({ error: "Too many sign-in attempts. Please wait 15 minutes and try again." });
    }

    const submittedUsername = typeof request.body?.username === "string" ? request.body.username : "";
    const submittedPassword = typeof request.body?.password === "string" ? request.body.password : "";
    if (!safeEqual(submittedUsername, username) || !safeEqual(submittedPassword, password)) {
      loginAttempts.set(ip, { startedAt: attempt.startedAt, count: attempt.count + 1 });
      return response.status(401).json({ error: "The username or password is incorrect." });
    }

    loginAttempts.delete(ip);
    const expiresAt = Math.floor(now / 1000) + sessionLifetimeSeconds;
    response.cookie(sessionCookie, createSessionToken(secret, expiresAt), {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: sessionLifetimeSeconds * 1000,
      path: "/api/admin"
    });
    response.set("Cache-Control", "no-store");
    return response.json({ signedIn: true });
  });

  app.delete("/api/admin/session", requireAdmin, (_request, response) => {
    response.clearCookie(sessionCookie, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/api/admin"
    });
    response.set("Cache-Control", "no-store");
    return response.status(204).end();
  });

  app.get("/api/admin/orders", requireAdmin, async (_request, response, next) => {
    if (!databaseReady || !pool) {
      return response.status(503).json({ error: "The order inbox is temporarily unavailable." });
    }

    try {
      const orders = await listRecentOrders(pool);
      response.set("Cache-Control", "no-store");
      return response.json({ orders });
    } catch (error) {
      return next(error);
    }
  });

  if (serveStatic) {
    app.use(express.static(publicRoot, {
      index: "index.html",
      maxAge: "1h",
      setHeaders(response, filePath) {
        if (path.basename(filePath) === "admin.html") response.setHeader("Cache-Control", "no-store");
      }
    }));
    app.use("/Images", express.static(path.join(projectRoot, "Images"), { maxAge: "1d" }));
    app.use("/Videos", express.static(path.join(projectRoot, "Videos"), { maxAge: "1d" }));
    app.get("/Styles.css", async (_request, response, next) => {
      try {
        response.type("text/css").send(await readFile(path.join(projectRoot, "Styles.css")));
      } catch (error) {
        next(error);
      }
    });

    const legacyRoutes = new Map([
      ["Home.html", "/#home"],
      ["Products and Services.html", "/#menu"],
      ["About Us.html", "/#about"],
      ["Contact Us.html", "/#contact"],
      ["Order.html", "/#menu"],
      ["Thabi's Sausage and Grill.html", "/#about"]
    ]);
    for (const [page, destination] of legacyRoutes) {
      app.get(`/${page}`, (_request, response) => response.redirect(302, destination));
    }
    app.get("/Gallery.html", (_request, response) => response.sendFile(path.join(projectRoot, "Gallery.html")));
  }

  app.use((error, _request, response, _next) => {
    if (error?.type === "entity.too.large") {
      return response.status(413).json({ error: "This request is too large. Please shorten the instructions and try again." });
    }
    if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
      return response.status(400).json({ error: "The request could not be read. Please try again." });
    }

    console.error("Request failed:", error?.message || "Unknown application error");
    return response.status(500).json({ error: "We could not complete that request. Please try again or contact the business." });
  });

  return {
    app,
    markDatabaseReady() {
      databaseReady = true;
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required. Copy .env.example and configure a PostgreSQL database.");
    process.exitCode = 1;
  } else {
    const pool = new pg.Pool({
      connectionString,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
      max: 10,
      connectionTimeoutMillis: 10_000
    });
    const { app, markDatabaseReady } = createApp({ pool });
    initializeDatabase(pool)
      .then(() => {
        markDatabaseReady();
        const port = Number(process.env.PORT || 3000);
        app.listen(port, "0.0.0.0", () => console.info(`Website server is ready on port ${port}.`));
      })
      .catch((error) => {
        console.error("Database setup failed. Check DATABASE_URL and database connectivity:", error.message);
        process.exitCode = 1;
      });

    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => {
        pool.end().finally(() => process.exit(0));
      });
    }
  }
}
