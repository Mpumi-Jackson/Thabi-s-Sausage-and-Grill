const currency = new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" });
const cartStorageKey = "tsg-cart-v1";
const submissionKey = "tsg-order-idempotency";
const routes = new Set(["home", "menu", "cart", "checkout", "confirmation", "about", "contact"]);
const state = {
  products: [],
  categories: [],
  business: null,
  sampleMenu: true,
  menuConfirmed: false,
  orderingAvailable: false,
  activeCategory: "all",
  cart: readCart(),
  submitting: false,
  lastOrder: null,
  toastTimer: null
};

function readCart() {
  try {
    const saved = JSON.parse(localStorage.getItem(cartStorageKey) || "{}");
    if (!saved || Array.isArray(saved) || typeof saved !== "object") return {};
    return Object.fromEntries(
      Object.entries(saved).filter(([, quantity]) => Number.isInteger(quantity) && quantity > 0 && quantity <= 99)
    );
  } catch {
    showToast("The saved basket could not be read on this device. Starting with an empty basket.");
    return {};
  }
}

function saveCart() {
  try {
    localStorage.setItem(cartStorageKey, JSON.stringify(state.cart));
    return true;
  } catch {
    showToast("Your basket could not be saved on this device. It may not remain after you leave this page.");
    return false;
  }
}

function money(cents) {
  return currency.format(cents / 100);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function getCartItems() {
  return Object.entries(state.cart).flatMap(([id, quantity]) => {
    const product = state.products.find((item) => item.id === id);
    return product?.available ? [{ ...product, quantity, lineTotalCents: product.priceCents * quantity }] : [];
  });
}

function getSubtotal() {
  return getCartItems().reduce((sum, item) => sum + item.lineTotalCents, 0);
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => { toast.hidden = true; }, 4500);
}

function setMessage(element, message) {
  if (!element) return;
  element.textContent = message;
  element.hidden = !message;
}

function showPage(route) {
  const page = routes.has(route) ? route : "home";
  for (const section of document.querySelectorAll("[data-page]")) {
    section.hidden = section.dataset.page !== page;
  }
  for (const link of document.querySelectorAll("[data-route]")) {
    if (link.dataset.route === page) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }

  document.title = `${page === "home" ? "A South African grill" : page[0].toUpperCase() + page.slice(1)} | Thabi's Sausage and Grill`;
  document.querySelector("#primary-nav").classList.remove("nav-open");
  document.querySelector("#nav-toggle").setAttribute("aria-expanded", "false");

  if (page === "menu") renderMenu();
  if (page === "cart") renderCart();
  if (page === "checkout") renderCheckout();
  if (page === "confirmation") renderConfirmation();
  if (page === "contact") renderContact();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function productCard(product) {
  return `
    <article class="product-card">
      <div class="product-image-wrap">
        <img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.imageAlt)}" loading="lazy" width="640" height="480">
        <span class="product-badge">${state.sampleMenu ? "Sample price" : "Menu price"}</span>
      </div>
      <div class="product-copy">
        <div class="product-title-row"><h3>${escapeHtml(product.name)}</h3><strong>${money(product.priceCents)}</strong></div>
        <p>${escapeHtml(product.description)}</p>
        <button class="button button-secondary add-button" type="button" data-add="${escapeHtml(product.id)}" ${product.available ? "" : "disabled"}>
          ${product.available ? "Add to basket" : "Currently unavailable"}
        </button>
      </div>
    </article>`;
}

function renderMenu() {
  const menu = document.querySelector("#menu-products");
  const notice = document.querySelector("#menu-notice");
  const error = document.querySelector("#menu-error");
  setMessage(error, "");
  if (state.sampleMenu) {
    notice.innerHTML = "<strong>Sample menu only.</strong> Items are drawn from the existing site; all prices are examples and online ordering remains paused until the owner confirms the real menu and prices.";
  } else if (!state.orderingAvailable) {
    notice.innerHTML = "<strong>Menu prices have been confirmed, but online ordering is temporarily unavailable.</strong> Please contact the business directly.";
  } else {
    notice.innerHTML = "<strong>Menu and prices confirmed by the business.</strong> Online ordering is open.";
  }

  if (!state.products.length) {
    menu.innerHTML = '<div class="empty-state"><p>We could not load the menu right now.</p><button class="button button-secondary" type="button" id="retry-menu">Try again</button></div>';
    return;
  }

  const visibleProducts = state.products.filter((product) => (
    state.activeCategory === "all" || product.category === state.activeCategory
  ));
  menu.innerHTML = visibleProducts.length
    ? visibleProducts.map(productCard).join("")
    : `<div class="empty-state"><p>No ${state.sampleMenu ? "sample " : ""}items are listed in this category yet.</p></div>`;

  const categories = document.querySelector("#category-list");
  categories.innerHTML = [
    `<button type="button" class="category-chip ${state.activeCategory === "all" ? "is-active" : ""}" data-category="all" aria-pressed="${state.activeCategory === "all"}">All items</button>`,
    ...state.categories.map((category) => `
      <button type="button" class="category-chip ${state.activeCategory === category.id ? "is-active" : ""}" data-category="${escapeHtml(category.id)}" aria-pressed="${state.activeCategory === category.id}">
        ${escapeHtml(category.name)}
      </button>`)
  ].join("");
}

function renderFeatured() {
  const featured = state.products.filter((product) => product.available).slice(0, 3);
  document.querySelector("#featured-products").innerHTML = featured.map(productCard).join("");
}

function updateCartBadge() {
  const count = Object.values(state.cart).reduce((sum, quantity) => sum + quantity, 0);
  const badge = document.querySelector("#cart-count");
  badge.textContent = String(count);
  badge.setAttribute("aria-label", `${count} ${count === 1 ? "item" : "items"}`);
}

function updateCart(id, change) {
  const product = state.products.find((item) => item.id === id);
  if (!product || !product.available) return;
  const nextQuantity = (state.cart[id] || 0) + change;
  if (nextQuantity > 99) {
    showToast("You can add up to 99 of an item.");
    return;
  }
  if (nextQuantity < 1) delete state.cart[id];
  else state.cart[id] = nextQuantity;

  sessionStorage.removeItem(submissionKey);
  saveCart();
  updateCartBadge();
  if (window.location.hash === "#cart") renderCart();
  if (window.location.hash === "#checkout") renderCheckout();
}

function cartRow(item) {
  return `
    <article class="cart-row">
      <img src="${escapeHtml(item.image)}" alt="" loading="lazy" width="96" height="96">
      <div class="cart-row-info">
        <h2>${escapeHtml(item.name)}</h2>
        <p>${money(item.priceCents)} each <span aria-hidden="true">·</span> ${money(item.lineTotalCents)}</p>
        <div class="quantity-controls" aria-label="Quantity for ${escapeHtml(item.name)}">
          <button type="button" data-quantity="-1" data-id="${escapeHtml(item.id)}" aria-label="Remove one ${escapeHtml(item.name)}">−</button>
          <span aria-live="polite">${item.quantity}</span>
          <button type="button" data-quantity="1" data-id="${escapeHtml(item.id)}" aria-label="Add one ${escapeHtml(item.name)}">+</button>
          <button type="button" class="remove-button" data-remove="${escapeHtml(item.id)}">Remove</button>
        </div>
      </div>
    </article>`;
}

function renderCart() {
  const items = getCartItems();
  const list = document.querySelector("#cart-lines");
  list.innerHTML = items.length
    ? items.map(cartRow).join("")
    : `<div class="empty-state"><span class="empty-icon" aria-hidden="true">＋</span><h2>Your basket is waiting</h2><p>Browse the ${state.sampleMenu ? "sample " : ""}menu and add something to get started.</p><a class="button button-primary" href="#menu">Browse ${state.sampleMenu ? "sample " : ""}menu</a></div>`;
  document.querySelector("#cart-subtotal").textContent = money(getSubtotal());
  document.querySelector("#cart-summary-title").textContent = state.sampleMenu ? "Sample order summary" : "Order summary";
  document.querySelector("#cart-lines").closest(".checkout-layout").querySelector(".summary-row span").textContent = state.sampleMenu ? "Sample subtotal" : "Subtotal";
  document.querySelector("#cart-subtitle").textContent = `Adjust your ${state.sampleMenu ? "sample " : ""}order below. No order is sent until you choose to submit it.`;
  document.querySelector("#back-to-menu").textContent = `← Back to ${state.sampleMenu ? "sample " : ""}menu`;
  const checkout = document.querySelector("#checkout-link");
  checkout.setAttribute("aria-disabled", String(items.length === 0));
  checkout.classList.toggle("is-disabled", items.length === 0);
}

function renderCheckout() {
  const items = getCartItems();
  document.querySelector("#checkout-items").innerHTML = items.length
    ? items.map((item) => `
      <div class="checkout-item"><span>${item.quantity} × ${escapeHtml(item.name)}</span><strong>${money(item.lineTotalCents)}</strong></div>`).join("")
    : '<p class="muted">Your basket is empty. <a class="text-link" href="#menu">Browse the menu</a>.</p>';
  document.querySelector("#checkout-total").textContent = money(getSubtotal());
  document.querySelector("#checkout-summary-title").textContent = state.sampleMenu ? "Sample order" : "Your order";
  document.querySelector("#checkout-notice").innerHTML = state.sampleMenu
    ? "<strong>Ordering is not open yet.</strong> This menu and total are samples only; no order will be submitted until the business confirms real menu prices."
    : state.orderingAvailable
      ? "<strong>Menu confirmed.</strong> Review your order details before submitting."
      : "<strong>Online ordering is temporarily unavailable.</strong> Your order has not been sent. Please contact the business directly.";
  const subtotalLabel = document.querySelector("#checkout-total").parentElement.querySelector("span");
  subtotalLabel.textContent = state.sampleMenu ? "Sample total" : "Order total";
  const sampleFlag = document.querySelector("#checkout-total").parentElement.nextElementSibling;
  sampleFlag.hidden = !state.sampleMenu;
  const form = document.querySelector("#checkout-form");
  const button = document.querySelector("#submit-order");
  button.disabled = items.length === 0 || state.submitting;
  setMessage(document.querySelector("#checkout-error"), "");
}

function renderConfirmation() {
  if (!state.lastOrder) {
    document.querySelector("#confirmation-content").innerHTML = `
      <p class="eyebrow">Order status</p><h1>Confirmation <span>unavailable</span></h1>
      <p>There is no saved order confirmation in this browser session. An order is only confirmed after the business database saves it.</p>
      <a class="button button-primary" href="#menu">Back to sample menu</a>`;
    return;
  }

  const order = state.lastOrder;
  document.querySelector("#confirmation-reference").textContent = `Reference: ${order.reference}`;
  document.querySelector("#confirmation-date").textContent = new Intl.DateTimeFormat("en-ZA", {
    dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Johannesburg"
  }).format(new Date(order.createdAt));
  document.querySelector("#confirmation-items").innerHTML = order.items.map((item) => `
    <div class="checkout-item"><span>${item.quantity} × ${escapeHtml(item.name)}</span><strong>${money(item.lineTotalCents)}</strong></div>`).join("");
  document.querySelector("#confirmation-total").textContent = money(order.totalCents);
}

function addPhoneLink(element, phone, label) {
  element.textContent = phone || "Contact details to be confirmed.";
  element.href = phone ? `tel:${phone.replace(/[^\d+]/g, "")}` : "#contact";
  if (!phone) element.setAttribute("aria-disabled", "true");
  else element.removeAttribute("aria-disabled");
  element.setAttribute("aria-label", label);
}

function renderContact() {
  if (!state.business) return;
  const business = state.business;
  addPhoneLink(document.querySelector("#contact-phone"), business.phone, `Call ${business.phone || "the business"}`);
  addPhoneLink(document.querySelector("#contact-whatsapp"), business.whatsapp, `WhatsApp ${business.whatsapp || "the business"}`);

  const whatsapp = document.querySelector("#contact-whatsapp");
  if (business.whatsapp) {
    let number = business.whatsapp.replace(/\D/g, "");
    if (number.startsWith("0")) number = `27${number.slice(1)}`;
    whatsapp.href = `https://wa.me/${number}`;
    whatsapp.target = "_blank";
    whatsapp.rel = "noopener noreferrer";
  }

  const instagram = document.querySelector("#contact-instagram");
  const handle = business.instagram || "";
  instagram.textContent = handle || "Instagram details to be confirmed.";
  instagram.href = handle ? `https://www.instagram.com/${handle.replace(/^@/, "")}/` : "#contact";
  if (handle) {
    instagram.target = "_blank";
    instagram.rel = "noopener noreferrer";
  }
  document.querySelector("#contact-location").textContent = `Location: ${business.location || "please contact us to confirm the current location and collection arrangements."}`;
  document.querySelector("#contact-hours").textContent = `Opening hours: ${business.hours || "please contact us to confirm current hours."}`;
  if (business.deliveryEnabled && business.deliveryServiceArea) {
    const option = document.createElement("option");
    option.value = "delivery";
    option.textContent = "Delivery";
    document.querySelector("#fulfillment").append(option);
    document.querySelector("#delivery-area-note").textContent = `Delivery is configured for: ${business.deliveryServiceArea}. Please confirm your address is in this area.`;
  }
}

async function submitOrder(event) {
  event.preventDefault();
  if (state.submitting) return;

  const form = event.currentTarget;
  const error = document.querySelector("#checkout-error");
  const items = getCartItems();
  if (!items.length) {
    setMessage(error, "Your basket is empty. Add a menu item before continuing.");
    return;
  }
  if (!form.reportValidity()) return;

  const formData = new FormData(form);
  const fulfillment = String(formData.get("fulfillment"));
  const requestBody = {
    customer: { name: String(formData.get("name")), phone: String(formData.get("phone")) },
    fulfillment,
    address: String(formData.get("address") || ""),
    instructions: String(formData.get("instructions") || ""),
    items: items.map((item) => ({ id: item.id, quantity: item.quantity }))
  };

  let idempotencyKey = sessionStorage.getItem(submissionKey);
  if (!idempotencyKey) {
    idempotencyKey = crypto.randomUUID();
    sessionStorage.setItem(submissionKey, idempotencyKey);
  }

  state.submitting = true;
  const button = document.querySelector("#submit-order");
  button.disabled = true;
  button.textContent = "Sending securely…";
  setMessage(error, "");

  try {
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(requestBody),
      credentials: "same-origin"
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "We could not submit your order.");

    state.lastOrder = result;
    state.cart = {};
    saveCart();
    updateCartBadge();
    sessionStorage.removeItem(submissionKey);
    form.reset();
    window.location.hash = "#confirmation";
  } catch (submissionError) {
    setMessage(error, submissionError instanceof TypeError
      ? "We could not reach the ordering service. Your order has not been confirmed. Please try again or contact the business."
      : submissionError.message);
  } finally {
    state.submitting = false;
    button.disabled = getCartItems().length === 0;
    button.innerHTML = 'Place order <span aria-hidden="true">→</span>';
  }
}

async function loadStore() {
  try {
    const [menuResponse, businessResponse] = await Promise.all([fetch("/api/menu"), fetch("/api/business")]);
    if (!menuResponse.ok || !businessResponse.ok) throw new Error("The menu service is unavailable.");
    const [menu, business] = await Promise.all([menuResponse.json(), businessResponse.json()]);
    state.products = menu.products;
    state.categories = menu.categories;
    state.sampleMenu = menu.sampleMenu;
    state.menuConfirmed = menu.menuConfirmed;
    state.business = business;
    state.orderingAvailable = business.onlineOrderingEnabled;
    document.querySelector("#menu-subtitle").textContent = `Take a look around and add ${state.sampleMenu ? "sample items" : "items"} to your basket.`;
    document.querySelector("#about-title").parentElement.querySelector(".button").textContent =
      `Browse the ${state.sampleMenu ? "sample " : ""}menu →`;
    document.querySelector("#footer-note").textContent = state.sampleMenu
      ? "Menu details and prices must be confirmed by the business before online orders open."
      : "Contact the business if you need to confirm any order or collection details.";
    const homeNotice = document.querySelector("#home-menu-notice");
    if (state.sampleMenu) {
      homeNotice.innerHTML = "<strong>Menu preview:</strong> these sample items and prices are illustrative, not a confirmed menu. Online orders are not open yet.";
    } else if (!state.orderingAvailable) {
      homeNotice.innerHTML = "<strong>Menu prices are confirmed, but online ordering is temporarily unavailable.</strong> Please contact the business directly.";
    } else {
      homeNotice.innerHTML = "<strong>Menu and prices confirmed by the business.</strong> Browse the menu and place an order online.";
    }
    const validIds = new Set(state.products.filter((product) => product.available).map((product) => product.id));
    state.cart = Object.fromEntries(Object.entries(state.cart).filter(([id]) => validIds.has(id)));
    saveCart();
    renderFeatured();
    renderContact();
    updateCartBadge();
    showPage(window.location.hash.slice(1));
  } catch {
    setMessage(document.querySelector("#menu-error"), "The menu could not be loaded. Please refresh the page or contact the business.");
    for (const menu of ["#featured-products", "#menu-products"]) {
      document.querySelector(menu).innerHTML = `
        <div class="empty-state"><p>Menu items are temporarily unavailable. No order has been submitted.</p>
          <button class="button button-secondary" type="button" id="retry-menu">Try again</button></div>`;
    }
  }
}

document.querySelector("#nav-toggle").addEventListener("click", (event) => {
  const nav = document.querySelector("#primary-nav");
  const open = nav.classList.toggle("nav-open");
  event.currentTarget.setAttribute("aria-expanded", String(open));
});

window.addEventListener("hashchange", () => showPage(window.location.hash.slice(1)));
document.querySelector("#menu-products").addEventListener("click", (event) => {
  const addButton = event.target.closest("[data-add]");
  const categoryButton = event.target.closest("[data-category]");
  if (event.target.closest("#retry-menu")) loadStore();
  if (addButton) {
    updateCart(addButton.dataset.add, 1);
    showToast(`${state.products.find((item) => item.id === addButton.dataset.add)?.name || "Item"} added to your sample basket.`);
  }
  if (categoryButton) {
    state.activeCategory = categoryButton.dataset.category;
    renderMenu();
    document.querySelector(`[data-category="${CSS.escape(state.activeCategory)}"]`)?.focus();
  }
});

document.querySelector("#category-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-category]");
  if (!button) return;
  state.activeCategory = button.dataset.category;
  renderMenu();
  document.querySelector(`[data-category="${CSS.escape(state.activeCategory)}"]`)?.focus();
});

document.querySelector("#featured-products").addEventListener("click", (event) => {
  if (event.target.closest("#retry-menu")) {
    loadStore();
    return;
  }
  const button = event.target.closest("[data-add]");
  if (!button) return;
  updateCart(button.dataset.add, 1);
  showToast(`${state.products.find((item) => item.id === button.dataset.add)?.name || "Item"} added to your sample basket.`);
});

document.querySelector("#cart-lines").addEventListener("click", (event) => {
  const quantityButton = event.target.closest("[data-quantity]");
  const removeButton = event.target.closest("[data-remove]");
  if (quantityButton) updateCart(quantityButton.dataset.id, Number(quantityButton.dataset.quantity));
  if (removeButton) {
    delete state.cart[removeButton.dataset.remove];
    sessionStorage.removeItem(submissionKey);
    saveCart();
    updateCartBadge();
    renderCart();
  }
});

document.querySelector("#checkout-link").addEventListener("click", (event) => {
  if (getCartItems().length === 0) event.preventDefault();
});

document.querySelector("#fulfillment").addEventListener("change", (event) => {
  const address = document.querySelector("#address-field");
  const visible = event.currentTarget.value === "delivery";
  address.hidden = !visible;
  address.querySelector("textarea").required = visible;
});

document.querySelector("#checkout-form").addEventListener("submit", submitOrder);
document.querySelector("#footer-year").textContent = new Intl.DateTimeFormat("en-ZA", {
  year: "numeric", timeZone: "Africa/Johannesburg"
}).format(new Date());

loadStore();
