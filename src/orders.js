import { randomBytes } from "node:crypto";

const MAX_QUANTITY = 99;

export function normalizeSouthAfricanPhone(value) {
  const phone = typeof value === "string" ? value.replace(/[\s()-]/g, "") : "";
  return /^(?:\+27|0)[1-8]\d{8}$/.test(phone) ? phone : null;
}

export function validateOrderInput(body, { products, menuConfirmed, deliveryEnabled }) {
  if (!menuConfirmed || products.some((product) => product.samplePrice !== false)) {
    return { error: "Online ordering is paused until the business confirms its menu and prices." };
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Please check your order details and try again." };
  }

  const customer = body.customer;
  const name = typeof customer?.name === "string" ? customer.name.trim() : "";
  const phone = normalizeSouthAfricanPhone(customer?.phone);
  if (name.length < 2 || name.length > 100 || !phone) {
    return { error: "Enter your name and a valid South African contact number." };
  }

  const fulfillment = body.fulfillment;
  if (fulfillment !== "collection" && !(deliveryEnabled && fulfillment === "delivery")) {
    return { error: "Choose an available collection or delivery option." };
  }

  const address = typeof body.address === "string" ? body.address.trim() : "";
  if (fulfillment === "delivery" && (address.length < 5 || address.length > 250)) {
    return { error: "Enter a delivery address between 5 and 250 characters." };
  }

  const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";
  if (instructions.length > 500) {
    return { error: "Instructions must be 500 characters or fewer." };
  }

  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 30) {
    return { error: "Add at least one menu item to your order." };
  }

  const productMap = new Map(products.map((product) => [product.id, product]));
  const seen = new Set();
  const items = [];
  let totalCents = 0;

  for (const item of body.items) {
    const product = productMap.get(item?.id);
    const quantity = item?.quantity;
    if (
      !product ||
      !product.available ||
      seen.has(product.id) ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_QUANTITY
    ) {
      return { error: "An item in your order is unavailable. Please refresh the menu and try again." };
    }

    seen.add(product.id);
    const lineTotalCents = product.priceCents * quantity;
    if (!Number.isSafeInteger(lineTotalCents) || !Number.isSafeInteger(totalCents + lineTotalCents)) {
      return { error: "Your order total is too large. Please reduce the quantities and try again." };
    }

    totalCents += lineTotalCents;
    items.push({
      id: product.id,
      name: product.name,
      quantity,
      unitPriceCents: product.priceCents,
      lineTotalCents
    });
  }

  return {
    order: {
      name,
      phone,
      fulfillment,
      address: fulfillment === "delivery" ? address : null,
      instructions: instructions || null,
      items,
      totalCents
    }
  };
}

export function createOrderReference(now = new Date()) {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now).replaceAll("-", "");
  return `TSG-${date}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

export async function saveOrder(pool, order, idempotencyKey) {
  const orderReference = createOrderReference();
  const result = await pool.query(
    `INSERT INTO orders (
       order_reference, idempotency_key, customer_name, customer_phone,
       fulfillment, delivery_address, instructions, items, total_cents
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING order_reference, created_at`,
    [
      orderReference,
      idempotencyKey,
      order.name,
      order.phone,
      order.fulfillment,
      order.address,
      order.instructions,
      JSON.stringify(order.items),
      order.totalCents
    ]
  );

  if (result.rows[0]) {
    return { ...order, reference: result.rows[0].order_reference, createdAt: result.rows[0].created_at };
  }

  const existing = await pool.query(
    `SELECT order_reference, created_at, customer_name, customer_phone, fulfillment,
            delivery_address, instructions, items, total_cents
     FROM orders WHERE idempotency_key = $1`,
    [idempotencyKey]
  );
  const saved = existing.rows[0];
  if (!saved) {
    throw new Error("Unable to verify an order after an idempotent insert.");
  }

  return {
    name: saved.customer_name,
    phone: saved.customer_phone,
    fulfillment: saved.fulfillment,
    address: saved.delivery_address,
    instructions: saved.instructions,
    items: saved.items,
    totalCents: saved.total_cents,
    reference: saved.order_reference,
    createdAt: saved.created_at
  };
}

export async function initializeDatabase(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      order_reference TEXT NOT NULL UNIQUE,
      idempotency_key UUID NOT NULL UNIQUE,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      fulfillment TEXT NOT NULL CHECK (fulfillment IN ('collection', 'delivery')),
      delivery_address TEXT,
      instructions TEXT,
      items JSONB NOT NULL,
      total_cents BIGINT NOT NULL CHECK (total_cents >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function listRecentOrders(pool) {
  const result = await pool.query(
    `SELECT order_reference AS reference, created_at AS "createdAt",
            customer_name AS name, customer_phone AS phone,
            fulfillment, delivery_address AS address, instructions,
            items, total_cents AS "totalCents"
     FROM orders
     ORDER BY created_at DESC
     LIMIT 100`
  );
  return result.rows;
}
