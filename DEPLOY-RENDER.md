# KPOT To Go — deploying on Render

Roughly 10 minutes, and most of it is waiting. Read each step before clicking.

---

## 0. What you need first

- A **GitHub** account (you have one: `shigene-netizen`) with the KPOT code pushed to a **private** repo.
- A **Render** account — sign up at https://render.com (log in with GitHub, it's quicker).
- A **credit card** for Render. The service plan is about **$7/month** — the persistent disk that keeps your orders is not available on the free tier.

---

## 1. Create the service from the blueprint

1. In Render: **Dashboard → New + → Blueprint**
2. Connect your GitHub account if asked, then pick the **kpot-order** repo
3. Render reads `render.yaml` and shows what it will create — one Web Service plus a 1 GB disk
4. Click **Apply**

The service, the disk and all the data paths are created from `render.yaml`. You do not need to fill in a form.

---

## 2. Set the three secrets (the important bit)

`render.yaml` deliberately does **not** contain secrets — they go in the dashboard:

1. Open the service → **Environment** in the left menu
2. Add these three:

| Key | What to put |
|---|---|
| `STRIPE_SECRET_KEY` | Your Stripe secret key — `sk_live_...` (or `sk_test_...` while testing) |
| `ADMIN_KEY` | Any long random string. This unlocks the kitchen board and admin console. |
| `PRINT_KEY` | A **different** long random string. The in-store print agent uses this one. |

**`PRINT_KEY` must not equal `ADMIN_KEY`.** If `ADMIN_KEY` is set but `PRINT_KEY` is missing, the print endpoint is locked and no kitchen tickets come out.

3. **Save Changes** — Render redeploys automatically.

Tip: run this twice and use the two results as the two keys:
```
openssl rand -hex 24
```

---

## 3. Wait for it to come up

- First deploy takes a couple of minutes.
- Watch **Events** — you want `Deploy ... live`.
- Render's health check polls `/api/health`.

Then check it yourself:
```
https://<your-service>.onrender.com/api/health     →  {"ok":true}
```

---

## 4. Point your domain at it

You own **www.kpotexpress.com**. Two choices:

**A. Keep the redirect layer (recommended — no reprints, ever)**
Change one line in `kpot-redirect/target.js`:
```js
baseUrl: 'https://<your-service>.onrender.com'
```
commit and push. Every printed QR code keeps working, and the print agent finds the new address by itself.

**B. Point the domain straight at Render**
In Render: service → **Settings → Custom Domains → Add** → `www.kpotexpress.com`,
then add the CNAME Render shows you in Squarespace DNS (replacing the current
`shigene-netizen.github.io` one).

A is safer: the app address can change again later and you still never reprint.

---

## 5. Update the print agent (kitchen PC)

Printing needs the key you set in step 2:

1. On the shop PC, open `print-agent/config.json`
2. Set `"printKey"` to the **same** value as Render's `PRINT_KEY`
3. Make sure `printerHost` is the printer's IP
4. Restart `start.bat`

---

## 6. Check it end to end

- Guest page: `https://<your-service>.onrender.com/`
- Kitchen board: `.../admin-orders.html` (needs the admin key)
- Print status: `.../api/print/status` (needs admin or print key)
- Place a test order and confirm a ticket comes out of the printer

---

## Notes

- **Free tier is not enough.** No persistent disk means orders vanish on every restart or redeploy.
- Render's free/starter services **spin down when idle**. The first visitor after an idle period waits ~30s. For a restaurant, consider keeping it warm (an uptime monitor pinging `/api/health` works).
- **Orders do not migrate.** The new host starts with an empty order board. Old orders live in `orders.local.json` on the old host — export before you switch if you need them.
