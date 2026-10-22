const loginPanel = document.querySelector("#login-panel");
const inboxPanel = document.querySelector("#inbox-panel");
const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
const inboxError = document.querySelector("#inbox-error");
const orderList = document.querySelector("#order-list");
const currency = new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" });

function formatMoney(cents) {
  return currency.format(Number(cents) / 100);
}

function showError(element, message) {
  element.textContent = message;
  element.hidden = !message;
}

function showInbox() {
  loginPanel.hidden = true;
  inboxPanel.hidden = false;
}

function showLogin() {
  inboxPanel.hidden = true;
  loginPanel.hidden = false;
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat("en-ZA", {
    dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Johannesburg"
  }).format(new Date(timestamp));
}

function renderOrders(orders) {
  if (!orders.length) {
    orderList.innerHTML = '<div class="empty-state"><h2>No orders yet</h2><p>Orders saved by customers will appear here.</p></div>';
    return;
  }

  orderList.replaceChildren(...orders.map((order) => {
    const card = document.createElement("article");
    card.className = "order-card";

    const heading = document.createElement("div");
    heading.className = "order-card-heading";
    const reference = document.createElement("h2");
    reference.textContent = order.reference;
    const date = document.createElement("time");
    date.dateTime = order.createdAt;
    date.textContent = formatDate(order.createdAt);
    heading.append(reference, date);

    const customer = document.createElement("p");
    customer.className = "order-customer";
    customer.textContent = `${order.name} · ${order.phone}`;

    const fulfillment = document.createElement("p");
    fulfillment.textContent = order.fulfillment === "delivery"
      ? `Delivery · ${order.address || "Address not provided"}`
      : "Collection";

    const items = document.createElement("ul");
    items.className = "order-item-list";
    for (const item of order.items) {
      const line = document.createElement("li");
      line.textContent = `${item.quantity} × ${item.name} — ${formatMoney(item.lineTotalCents)}`;
      items.append(line);
    }

    const instructions = document.createElement("p");
    instructions.className = "order-instructions";
    instructions.textContent = order.instructions ? `Instructions: ${order.instructions}` : "No special instructions.";

    const total = document.createElement("p");
    total.className = "order-total";
    total.textContent = `Order total: ${formatMoney(order.totalCents)}`;
    card.append(heading, customer, fulfillment, items, instructions, total);
    return card;
  }));
}

async function loadOrders() {
  showError(inboxError, "");
  orderList.innerHTML = '<p class="muted" role="status">Loading orders…</p>';
  try {
    const response = await fetch("/api/admin/orders", { credentials: "same-origin", cache: "no-store" });
    const result = await response.json();
    if (response.status === 401) {
      showLogin();
      return;
    }
    if (!response.ok) throw new Error(result.error || "Could not load orders.");
    showInbox();
    renderOrders(result.orders);
  } catch (error) {
    showError(inboxError, error instanceof TypeError
      ? "Could not reach the order inbox. Check the connection and try again."
      : error.message);
    orderList.replaceChildren();
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!loginForm.reportValidity()) return;
  const formData = new FormData(loginForm);
  const button = loginForm.querySelector("button[type=submit]");
  button.disabled = true;
  button.textContent = "Signing in…";
  showError(loginError, "");

  try {
    const response = await fetch("/api/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        username: String(formData.get("username")),
        password: String(formData.get("password"))
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Sign-in failed.");
    loginForm.reset();
    await loadOrders();
  } catch (error) {
    showError(loginError, error instanceof TypeError
      ? "Could not reach the sign-in service. Please try again."
      : error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Sign in";
  }
});

document.querySelector("#refresh-orders").addEventListener("click", loadOrders);
document.querySelector("#sign-out").addEventListener("click", async () => {
  try {
    const response = await fetch("/api/admin/session", {
      method: "DELETE",
      credentials: "same-origin",
      cache: "no-store"
    });
    if (!response.ok) throw new Error("Could not end the inbox session. Please close this browser tab.");
    showLogin();
  } catch (error) {
    showError(inboxError, error instanceof TypeError
      ? "Could not reach the sign-out service. Please close this browser tab."
      : error.message);
  }
});

loadOrders();
