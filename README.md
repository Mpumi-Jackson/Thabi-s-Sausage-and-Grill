# Thabi's Sausage and Grill

A mobile-friendly storefront and online ordering service built on the existing HTML/CSS project. The storefront is served by a small Node.js/Express application, and accepted orders are stored in PostgreSQL. The business reviews saved orders in the private `/admin.html` inbox.

## Local development

Requirements: Node.js 22.9 or later and a PostgreSQL database.

1. Create a local PostgreSQL database named `thabis_orders`.
2. Copy `.env.example` to `.env` and set `DATABASE_URL` and the three private inbox credentials (`ADMIN_USERNAME`, `ADMIN_PASSWORD`, and a unique `ADMIN_SESSION_SECRET` of at least 32 characters).
3. Install dependencies and start the server:

   ```powershell
   npm install
   npm start
   ```

4. Open `http://localhost:3000/`. The private business inbox is at `http://localhost:3000/admin.html`.
5. Run `npm test` and `npm run check` to run the automated checks and JavaScript syntax checks.

The server creates its `orders` table on startup. It will not start if `DATABASE_URL` is missing or the database is unreachable. Do not use a public or shared database for local testing.

## Menu and fulfilment setup

The current menu prices are deliberately **illustrative sample prices**. The item names are taken from the existing site, but the owner must review every item, description, category, image, price, and availability before accepting real orders. New storefront images are resized and compressed copies of the business's existing photos; the originals remain untouched.

1. Edit `data/menu.js` with the owner's approved menu. Prices use integer cents (`R 45,00` is `4500` cents).
2. For every approved product, change `samplePrice: true` to `samplePrice: false`. The API refuses orders whenever even one product is still marked as a sample; merely changing `MENU_CONFIRMED` is not enough.
3. Set `MENU_CONFIRMED=true` in the service environment only after all product details and prices have been reviewed. New orders are validated against the server's menu; client-supplied prices are ignored.
4. Delivery is off by default. To offer it, set `DELIVERY_ENABLED=true` and configure `DELIVERY_SERVICE_AREA` with the business-approved area. Customers are asked to confirm their address is inside that area; the site does not automatically determine delivery distance or fees.
5. Set `BUSINESS_LOCATION`, `BUSINESS_HOURS`, `CONTACT_PHONE`, `CONTACT_WHATSAPP`, and `CONTACT_INSTAGRAM` to currently verified public details. Location and hours are not guessed.

Until the real menu has been entered and confirmed, customers may explore sample products and build a local basket, but submitting an order returns an explicit unavailable message. The site never presents a sample price as a confirmed order.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection string. Keep private. |
| `ADMIN_USERNAME` | Yes for inbox | Business inbox username. |
| `ADMIN_PASSWORD` | Yes for inbox | Unique, strong business inbox password. |
| `ADMIN_SESSION_SECRET` | Yes for inbox | At least 32 random characters; signs expiring admin sessions. |
| `MENU_CONFIRMED` | No; defaults to `false` | Set to `true` only after the real menu has replaced every sample. |
| `DELIVERY_ENABLED` | No; defaults to `false` | Offer delivery only when the business is ready. |
| `DELIVERY_SERVICE_AREA` | Required for delivery | Owner-defined service area shown to customers. |
| `CONTACT_PHONE` | No | Verified public telephone number. |
| `CONTACT_WHATSAPP` | No | Verified public WhatsApp number. |
| `CONTACT_INSTAGRAM` | No | Verified public Instagram handle. |
| `BUSINESS_LOCATION` | No | Verified collection/business location. |
| `BUSINESS_HOURS` | No | Verified operating hours. |
| `PORT` | No | HTTP port; defaults to `3000`. |
| `NODE_ENV` | No | Set to `production` on Render to enable secure session cookies. |

The site's previous public contact page lists `068 038 0071`, `084 533 4451`, and `@Thabang_phala`; these are carried into the Render Blueprint as editable defaults and should be checked by the owner before use.

## Render deployment

The root `render.yaml` is a Render Blueprint for the Node web service and its PostgreSQL database. It uses a Render Starter web service and a persistent Basic PostgreSQL plan; deploying the Blueprint creates paid Render resources. Check the current Render pricing and choose whether to proceed before creating it.

1. Commit and push the project, including `package-lock.json`, to the connected GitHub repository:

   ```powershell
   git add .
   git commit -m "Build online ordering website"
   git push origin main
   ```

2. In the Render dashboard, select **New → Blueprint**, connect `Mpumi-Jackson/Thabi-s-Sausage-and-Grill`, and review the resources and prices in the Blueprint before confirming creation.
3. Supply strong, unique values for `ADMIN_USERNAME` and `ADMIN_PASSWORD`. Render generates `ADMIN_SESSION_SECRET`.
4. Keep `MENU_CONFIRMED=false` and `DELIVERY_ENABLED=false` until the menu, prices, location, and fulfilment details are verified. Update public contact and location settings in the service environment.
5. Wait for the deployment to pass its `/healthz` check. The home page is at the service URL; open `/admin.html` to review orders privately.

Orders are saved in the connected PostgreSQL database before the customer sees a confirmation. The inbox displays customer contact and fulfilment information only after sign-in. No email or WhatsApp order notification is configured; the business must check the inbox. Payment processing is not implemented.

The existing standalone HTML pages and media remain in the repository. Legacy home, menu, about, contact, and order URLs route into their equivalent storefront sections; the existing gallery remains available as `Gallery.html`. The new Render application serves the preserved photo/video assets.
