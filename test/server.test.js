import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.js";
import { menuCategories, menuProducts } from "../data/menu.js";

const confirmedProducts = menuProducts.map((product) => ({ ...product, samplePrice: false }));

function createFakePool() {
  const orders = new Map();
  return {
    orders,
    async query(sql, values = []) {
      if (sql.includes("INSERT INTO orders")) {
        const [, key, name, phone, fulfillment, address, instructions, serializedItems, totalCents] = values;
        if (orders.has(key)) return { rows: [] };
        const order = {
          order_reference: values[0],
          idempotency_key: key,
          customer_name: name,
          customer_phone: phone,
          fulfillment,
          delivery_address: address,
          instructions,
          items: JSON.parse(serializedItems),
          total_cents: totalCents,
          created_at: "2026-10-22T09:00:00.000Z"
        };
        orders.set(key, order);
        return { rows: [{ order_reference: order.order_reference, created_at: order.created_at }] };
      }

      if (sql.includes("WHERE idempotency_key = $1")) {
        const order = orders.get(values[0]);
        return { rows: order ? [{
          order_reference: order.order_reference,
          created_at: order.created_at,
          customer_name: order.customer_name,
          customer_phone: order.customer_phone,
          fulfillment: order.fulfillment,
          delivery_address: order.delivery_address,
          instructions: order.instructions,
          items: order.items,
          total_cents: order.total_cents
        }] : [] };
      }

      if (sql.includes('AS reference')) {
        return { rows: [...orders.values()].map((order) => ({
          reference: order.order_reference,
          createdAt: order.created_at,
          name: order.customer_name,
          phone: order.customer_phone,
          fulfillment: order.fulfillment,
          address: order.delivery_address,
          instructions: order.instructions,
          items: order.items,
          totalCents: order.total_cents
        })) };
      }

      return { rows: [] };
    }
  };
}

async function startApp(t, options = {}) {
  const pool = createFakePool();
  const products = options.products || (options.env?.MENU_CONFIRMED === "false" ? menuProducts : confirmedProducts);
  const { app, markDatabaseReady } = createApp({
    pool,
    products,
    categories: menuCategories,
    env: {
      MENU_CONFIRMED: "true",
      ADMIN_USERNAME: "order-manager",
      ADMIN_PASSWORD: "test-only-passphrase",
      ADMIN_SESSION_SECRET: "test-only-session-secret-that-is-long-enough",
      NODE_ENV: "test",
      ...options.env
    },
    serveStatic: options.serveStatic || false
  });
  markDatabaseReady();
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return { pool, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

const validPayload = {
  customer: { name: "Test Customer", phone: "082 123 4567" },
  fulfillment: "collection",
  address: "",
  instructions: "",
  items: [{ id: "boerewors-roll", quantity: 2, unitPriceCents: 1 }]
};

test("reports health and the sample menu without exposing any order data", async (t) => {
  const { baseUrl } = await startApp(t, { env: { MENU_CONFIRMED: "false" } });
  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);

  const menuResponse = await fetch(`${baseUrl}/api/menu`);
  const menu = await menuResponse.json();
  assert.equal(menu.sampleMenu, true);
  assert.equal(menu.menuConfirmed, false);
  assert.equal(menu.products[0].isSample, true);

  const inbox = await fetch(`${baseUrl}/api/admin/orders`);
  assert.equal(inbox.status, 401);
  assert.equal(inbox.headers.get("cache-control"), "no-store");
});

test("persists an order once, calculates its price on the server and returns no customer details", async (t) => {
  const { baseUrl, pool } = await startApp(t);
  const idempotencyKey = "31234567-89ab-4cde-8fab-0123456789ab";
  const send = () => fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(validPayload)
  });

  const firstResponse = await send();
  const first = await firstResponse.json();
  assert.equal(firstResponse.status, 201);
  assert.match(first.reference, /^TSG-2026\d{4}-[A-F0-9]{6}$/);
  assert.equal(first.totalCents, 9000);
  assert.equal(first.items[0].lineTotalCents, 9000);
  assert.equal("phone" in first, false);
  assert.equal("name" in first, false);
  assert.equal(pool.orders.size, 1);

  const duplicateResponse = await send();
  const duplicate = await duplicateResponse.json();
  assert.equal(duplicateResponse.status, 201);
  assert.equal(duplicate.reference, first.reference);
  assert.equal(pool.orders.size, 1);
});

test("refuses to save or confirm any order while the menu still contains sample prices", async (t) => {
  const { baseUrl, pool } = await startApp(t, {
    env: { MENU_CONFIRMED: "true" },
    products: menuProducts
  });
  const response = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "41234567-89ab-4cde-8fab-0123456789ab"
    },
    body: JSON.stringify(validPayload)
  });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.match(body.error, /paused|confirms/i);
  assert.equal(pool.orders.size, 0);
});

test("protects the order inbox with an expiring HttpOnly session", async (t) => {
  const { baseUrl } = await startApp(t);
  const orderResponse = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "51234567-89ab-4cde-8fab-0123456789ab"
    },
    body: JSON.stringify(validPayload)
  });
  assert.equal(orderResponse.status, 201);

  const unauthenticated = await fetch(`${baseUrl}/api/admin/orders`);
  assert.equal(unauthenticated.status, 401);
  assert.doesNotMatch(await unauthenticated.text(), /Test Customer|0821234567/);

  const wrongLogin = await fetch(`${baseUrl}/api/admin/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "order-manager", password: "incorrect" })
  });
  assert.equal(wrongLogin.status, 401);

  const login = await fetch(`${baseUrl}/api/admin/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "order-manager", password: "test-only-passphrase" })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);

  const inbox = await fetch(`${baseUrl}/api/admin/orders`, { headers: { Cookie: cookie } });
  assert.equal(inbox.status, 200);
  assert.equal(inbox.headers.get("cache-control"), "no-store");
  const inboxData = await inbox.json();
  assert.equal(inboxData.orders.length, 1);
  assert.equal(inboxData.orders[0].name, "Test Customer");
  assert.equal(inboxData.orders[0].phone, "0821234567");
});

test("rejects malformed idempotency keys instead of accepting an order", async (t) => {
  const { baseUrl, pool } = await startApp(t);
  const response = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "not-a-uuid" },
    body: JSON.stringify(validPayload)
  });
  assert.equal(response.status, 400);
  assert.equal(pool.orders.size, 0);
});

test("serves the storefront and optimized photos while routing legacy orders into the new menu", async (t) => {
  const { baseUrl } = await startApp(t, { env: { MENU_CONFIRMED: "false" }, serveStatic: true });
  const storefront = await fetch(`${baseUrl}/`);
  assert.equal(storefront.status, 200);
  assert.match(await storefront.text(), /sample items and prices are illustrative/i);

  const photo = await fetch(`${baseUrl}/images/hero.jpg`, { method: "HEAD" });
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get("content-type"), "image/jpeg");
  assert.ok(Number(photo.headers.get("content-length")) < 1_000_000);

  const adminPage = await fetch(`${baseUrl}/admin.html`, { method: "HEAD" });
  assert.equal(adminPage.status, 200);
  assert.equal(adminPage.headers.get("cache-control"), "no-store");

  const legacyOrder = await fetch(`${baseUrl}/Order.html`, { redirect: "manual" });
  assert.equal(legacyOrder.status, 302);
  assert.equal(legacyOrder.headers.get("location"), "/#menu");

  const legacyGallery = await fetch(`${baseUrl}/Gallery.html`);
  assert.equal(legacyGallery.status, 200);
  assert.match(await legacyGallery.text(), /Gallery/);
});
