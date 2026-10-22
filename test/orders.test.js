import test from "node:test";
import assert from "node:assert/strict";
import { menuProducts } from "../data/menu.js";
import { createOrderReference, normalizeSouthAfricanPhone, validateOrderInput } from "../src/orders.js";

const confirmedProducts = menuProducts.map((product) => ({ ...product, samplePrice: false }));
const orderBody = {
  customer: { name: "Thabi Customer", phone: "082 123 4567" },
  fulfillment: "collection",
  items: [{ id: "boerewors-roll", quantity: 2 }]
};

test("normalizes valid South African phone spacing and rejects invalid numbers", () => {
  assert.equal(normalizeSouthAfricanPhone("082 123 4567"), "0821234567");
  assert.equal(normalizeSouthAfricanPhone("+27 82 123 4567"), "+27821234567");
  assert.equal(normalizeSouthAfricanPhone("123"), null);
  assert.equal(normalizeSouthAfricanPhone("+1 212 555 0123"), null);
});

test("does not accept sample menu prices for real orders", () => {
  const result = validateOrderInput(orderBody, {
    products: menuProducts,
    menuConfirmed: true,
    deliveryEnabled: false
  });
  assert.match(result.error, /paused|confirms/i);
});

test("calculates the authoritative total in integer cents, ignoring client prices", () => {
  const result = validateOrderInput({
    ...orderBody,
    items: [{ id: "boerewors-roll", quantity: 2, unitPriceCents: 1, price: 0 }]
  }, {
    products: confirmedProducts,
    menuConfirmed: true,
    deliveryEnabled: false
  });

  assert.equal(result.error, undefined);
  assert.equal(result.order.totalCents, 9000);
  assert.equal(result.order.items[0].unitPriceCents, 4500);
  assert.equal(result.order.phone, "0821234567");
});

test("rejects invalid quantities, duplicate items, and unavailable products", () => {
  for (const items of [
    [{ id: "boerewors-roll", quantity: 0 }],
    [{ id: "boerewors-roll", quantity: 1.5 }],
    [{ id: "boerewors-roll", quantity: 100 }],
    [{ id: "boerewors-roll", quantity: 1 }, { id: "boerewors-roll", quantity: 1 }],
    [{ id: "not-on-the-menu", quantity: 1 }]
  ]) {
    const result = validateOrderInput({ ...orderBody, items }, {
      products: confirmedProducts,
      menuConfirmed: true,
      deliveryEnabled: false
    });
    assert.ok(result.error);
  }

  const result = validateOrderInput({ ...orderBody, items: [{ id: "boerewors-roll", quantity: 1 }] }, {
    products: confirmedProducts.map((product) => ({ ...product, available: false })),
    menuConfirmed: true,
    deliveryEnabled: false
  });
  assert.match(result.error, /unavailable/i);
});

test("requires a valid address and an explicitly enabled delivery service", () => {
  const products = confirmedProducts;
  const deliveryBody = { ...orderBody, fulfillment: "delivery", address: "123 Example Street" };
  const disabled = validateOrderInput(deliveryBody, { products, menuConfirmed: true, deliveryEnabled: false });
  assert.match(disabled.error, /available/i);

  const missingAddress = validateOrderInput({ ...deliveryBody, address: "" }, {
    products,
    menuConfirmed: true,
    deliveryEnabled: true
  });
  assert.match(missingAddress.error, /address/i);

  const valid = validateOrderInput(deliveryBody, { products, menuConfirmed: true, deliveryEnabled: true });
  assert.equal(valid.order.fulfillment, "delivery");
  assert.equal(valid.order.address, "123 Example Street");
});

test("creates dated order references in the South African timezone", () => {
  assert.match(createOrderReference(new Date("2026-10-21T22:30:00.000Z")), /^TSG-20261022-[0-9A-F]{6}$/);
});
