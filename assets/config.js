/* ==========================================================================
   KPOT To Go — Store & Payment configuration
   --------------------------------------------------------------------------
   THIS IS THE ONLY FILE YOU NEED TO EDIT TO GO LIVE.
   Everything the app needs (store info, tax, tips, payment) lives here.
   ========================================================================== */

const CONFIG = {
  /* ---- Store identity -------------------------------------------------- */
  store: {
    name: 'KPOT To Go',
    legalName: 'KPOT Korean BBQ & Hot Pot',
    phone: '+1 (678) 335-5388',          // shown to guests
    phoneRaw: '16783355388',             // digits only — used for tap-to-call
    address: '2955 Cobb Pkwy SE, Suite 830, Atlanta, GA 30339',
    addressQuery: '2955 Cobb Pkwy SE Suite 830, Atlanta, GA 30339',
    hours: 'Sun–Thu 12:00 PM – 9:30 PM · Fri–Sat 12:00 PM – 10:30 PM',

    /* Machine-readable version of the hours above, so the app can show a real
       "Open now / Closed" state instead of always claiming to be open.
       Minutes are counted from midnight: 12:00 PM = 720, 9:30 PM = 1290,
       10:30 PM = 1350.
       These are SAME-DAY hours — the store closes in the evening, not after
       midnight, so the normal same-day branch of storeOpenState() applies.
       (The past-midnight branch is kept in app.js so a late-night schedule
       could be restored later without re-deriving the arithmetic.) */
    hoursSpec: {
      openMinute: 720,        // 12:00 PM — doors open, every day
      closeSunThu: 1290,      // 9:30 PM (Sun, Mon, Tue, Wed, Thu)
      closeFriSat: 1350,      // 10:30 PM (Fri, Sat)
      lastSeatingNote: 'Last seating is one hour before closing'
    },

    /* The shop's own timezone, as an IANA name. This is NOT decoration.

       Every date the server computes — "today", "tomorrow", and the exact
       moment the kitchen starts a scheduled delivery — is local-time
       arithmetic, so it is only correct if the HOST's clock is set to this
       zone. The server started life on a box running Etc/UTC and nothing
       noticed: a 12:00 PM–1:00 PM Atlanta window was handed a kitchen-start
       timestamp of 11:30 UTC, which is 7:30 AM in Atlanta — the kitchen
       would have started cooking a lunch delivery four hours early, and
       every night between 8 PM and midnight the server believed it was
       already tomorrow.

       server.js compares the host zone against this value at startup and
       warns loudly on a mismatch (see timezoneWarning). Fixing the host is
       one command — `sudo timedatectl set-timezone America/New_York` — and
       kpot-oracle/setup-kpot.sh now does it. */
    timezone: 'America/New_York'
  },

  /* ---- Money ----------------------------------------------------------- */
  // Sales tax rate. Set to your local rate (e.g. 0.07 = 7%).
  // Cobb County, GA (ZIP 30339) = 6.000%. Confirm with your accountant.
  taxRate: 0.06,
  // Card processing surcharge, if you pass it on. 0 = absorb it.
  cardSurchargeRate: 0,
  currency: 'USD',
  currencySymbol: '$',

  /* ---- Order types ----------------------------------------------------- */
  /* Order here IS the display order, and the first entry is what a guest gets
     when nothing else decides (see state.orderType in app.js and
     resolveOrderType()). Dine-In leads because this is a dine-in restaurant
     with a to-go counter, not the other way round. */
  orderTypes: [
    { id: 'dinein', n: 'Dine-In', d: 'Order from your table', icon: '🍽️' },
    { id: 'pickup', n: 'Pickup / To Go', d: 'Ready in ~20–25 min', icon: '🛍️' },
    { id: 'delivery', n: 'Delivery', d: 'Within 2 mi · ~40 min', icon: '🛵' }
  ],
  /* ---- Delivery -----------------------------------------------------------
     Delivery is next-day and windowed, not "in 40 minutes": the guest picks a
     DAY (tomorrow onwards, never a day the shop is closed) and a TIME WINDOW,
     and each window has a daily ceiling. The fee is deliberately small; what
     the guest pays in waiting is what buys the cheap price and keeps the
     kitchen from being ambushed.

     "Just instant delivery as well" is NOT offered on purpose — see
     schedule.js for what a windowed order does to auto-prepare and printing.

     Nothing here switches the channel on or off. That is `enabled` below, and
     it is the SAME switch the owner's board uses; the scheduled rules only
     apply to orders that get through it. */
  delivery: {
    // Set to false if you do not offer delivery yet (same as the old deliveryEnabled)
    enabled: false,

    /* Delivery is FREE right now — a promotion, not a permanent price.

       `fee` is the amount that is actually charged, and it is part of the
       TAXABLE base (the state taxes the delivery, not just the food), so
       changing it changes the total twice: once for the fee, once for the tax
       on the fee.

       `listFee` is display-only: the crossed-out "was" price the guest page
       prints next to the FREE label so the saving is visible. It never reaches
       the bill. Set it to 0 (or delete it) to stop showing a crossed-out price. */
    fee: 0,
    listFee: 1.99,

    /* ---- Delivery is prepaid ---------------------------------------------
       A delivery leaves the building: there is no counter to walk up to when
       the food arrives, and nothing to collect afterwards. So a delivery must
       be paid online, and a guest who picked "Pay at Counter" is refused
       rather than quietly downgraded.

       Since 2026-10-22 the same is true of PICKUP (owner's final decision),
       so this is no longer a delivery-specific rule — see
       counterChannelVerdict() in server.js, which covers both channels and
       has no switch. `allowCounter` used to live here; it is gone on purpose.
       If the shop has no online method configured, delivery orders simply
       cannot be placed until it has one; the guest page says so instead of
       dead-ending. */

    /* ---- Delivery minimum -------------------------------------------------
       The smallest food subtotal that may be delivered. The 2-mile rule
       (geo.js) decides WHERE we deliver; this decides HOW BIG an order has
       to be to earn a run — a driver crossing town for a $6 bowl loses the
       shop money, and "no minimum" was the one promise the old landing page
       made that this setting now takes back (owner's decision, 2026-10-19).

       Measured on the GROSS food subtotal: the line the guest's bill prints
       as "Subtotal", before any coupon or reward, and before tax, tip and
       the delivery fee. That is the number the guest can see and reconcile,
       so a refusal never reads as a bait-and-switch.

       Set to 0 (or delete the key) for no minimum. BOTH money gates enforce
       it — POST /api/checkout and POST /api/orders, see deliveryMinVerdict()
       in server.js — because the browser's warning is a courtesy and the
       request that moves money arrives from the client. */
    minSubtotal: 10,

    schedule: {
      /* Most orders per window per day. When a window is full the guest simply
         cannot pick it — no waiting list, no "we'll try". */
      perDayPerSlot: 10,

      /* How far ahead a guest may book. */
      maxDaysAhead: 7,

      /* How long before the window opens the kitchen starts. This is what
         makes a scheduled order come off the board by itself: nothing is
         cooked or printed before this moment. */
      leadMinutes: 30,

      /* Minutes from midnight, same convention as store.hoursSpec
         (720 = 12:00 PM, 1020 = 5:00 PM). These five one-hour windows cover
         12:00 PM – 5:00 PM, which sits inside the 12:00 PM opening hours, and
         schedule.js REFUSES a window that does not — a delivery the shop
         cannot fulfil is worse than a missing one.

         The id travels in the order payload and shows up on the board and in
         the logs, so it is deliberately readable. Changing an id does NOT
         re-map orders already placed; those keep whatever they were given. */
      slots: [
        { id: '12pm', label: '12:00 PM – 1:00 PM', start: 720, end: 780 },
        { id: '1pm',  label: '1:00 PM – 2:00 PM',  start: 780, end: 840 },
        { id: '2pm',  label: '2:00 PM – 3:00 PM',  start: 840, end: 900 },
        { id: '3pm',  label: '3:00 PM – 4:00 PM',  start: 900, end: 960 },
        { id: '4pm',  label: '4:00 PM – 5:00 PM',  start: 960, end: 1020 }
      ]
    }
  },

  /* ---- Monthly membership -------------------------------------------------
     A monthly fee buys four perks. There is no card on file and no automatic
     renewal: the owner taps "confirm renewal" in the console and the
     membership rolls forward one period. That is a deliberate trade — a
     Stripe subscription would mean storing cards and running subscription
     webhooks, and this project's orders were deliberately moved OFF webhooks.

     The numbers below are the conservative package: at $16 an order, four
     orders a month, the perks cost about $8.80 against the $9.99 fee. The
     generous package (10% + a $10 coupon) would cost roughly $17 and LOSE
     money on an ordinary member. Change these; they are the whole economics. */
  member: {
    enabled: true,
    fee: 9.99,             // shown in the console; the money is collected by hand
    periodDays: 30,        // one renewal = this many days
    percent: 5,            // % off every order. A garbage value means 0, not 200
    freeDelivery: true,    // waive the delivery fee on delivery orders
    pointsMultiplier: 2,   // points earned per dollar, multiplied
    couponValue: 5,        // one coupon per renewal period
    couponDays: 30,
    couponLabel: 'Member reward'
  },

  /* ---- Tips ------------------------------------------------------------ */
  /* Presets shown in the "Add a Tip" row. Mix the four types freely:
       { type: 'none' }              → "No Tip" (zero, always first)
       { type: 'amt',   amount: 1 }  → a FLAT dollar tip ($1)
       { type: 'pct',   rate: 0.15 } → a percentage of the subtotal (15%)
       { type: 'custom' }            → guest types any dollar amount
     Flat and custom amounts are sent to the server in dollars; the server
     re-validates them against the real bill, so a guest can never inflate a
     tip by editing the page. The percentage path is kept for flexibility but
     is not used by the default presets below. */
  tipPresets: [
    { type: 'none' },
    { type: 'amt', amount: 1 },
    { type: 'amt', amount: 2 },
    { type: 'amt', amount: 3 },
    { type: 'custom' }
  ],

  /* ---- First-time guest welcome offer -----------------------------------
     A brand-new mobile number gets this percentage off automatically — no
     code to type, no box to fill in. "New" is decided by the SERVER from the
     order history (the mobile number is the customer identity here), never by
     a flag the page sends, so a returning guest cannot claim it twice and a
     stranger cannot claim it at all.

     The number is the only identity we have, so the offer requires one: a guest
     who checks out without a mobile number simply pays full price. It also
     yields to any discount the guest explicitly chose (a code, their rewards,
     store credit) — first-timers who have a better offer keep it.

     Set enabled:false to turn it off without a deploy. Change percent / label
     freely; they are the whole economics of the welcome. */
  firstVisit: {
    enabled: true,
    percent: 10,          // % off the subtotal for a first-ever order
    minSubtotal: 0,       // smallest subtotal that still qualifies (0 = any)
    label: 'First-time guest — 10% off'
  },

  /* ---- Payment methods -------------------------------------------------
     'counter'  → guest pays at the table / to the server. DINE-IN ONLY.
     'stripe'   → online card / Apple Pay / Google Pay via Stripe.
     'venmo'    → deep-link to a Venmo business handle.
     'zelle'    → show a Zelle email/phone for manual transfer.
     ---------------------------------------------------------------------- */
  payment: {
    counter: {
      enabled: true,
      n: 'Pay at Counter',
      d: 'Cash or card at the table',

      /* ---- Pay at the counter is a DINE-IN method -----------------------
         Owner's decision (2026-10-22, final): pickup and delivery orders
         must ALWAYS be paid before the kitchen sees them, so the counter is
         not offered on either. A pickup guest is not in the building — there
         is no table to walk past and nobody to collect from when the food is
         ready — and a delivery leaves the building entirely. Only a guest
         sitting at a table may run a tab.

         This is enforced in server.js by counterChannelVerdict(), which is
         unconditional: it does NOT relax when no online method is
         configured. A shop without card processing simply cannot take
         pickup/delivery orders until it has one — the honest outcome, and
         the same rule delivery has always had.

         The ceiling below still applies to the one channel that may pay at
         the counter (dine-in): a very large table tab must still be
         prepaid. */
      maxTotal: 30
    },

    stripe: {
      /* ================================================================
         STRIPE — card / Apple Pay / Google Pay. NO PRODUCT TO CREATE.

         There are two ways to switch this on. Pick ONE.

         ▶ PATH A — Bundled server (recommended, nothing to paste here)
           The project ships with server.js, which creates the Stripe session
           itself and fills in the exact amount, so the guest types nothing.
           You do NOT edit this file at all. Instead:
             1. Put your Stripe secret key in secrets.local.json
                (copy secrets.local.json.example → secrets.local.json)
             2. Run the app with `npm start` instead of a static file server
           The page detects the server automatically via /api/health and
           switches to the pre-filled amount. Leave `paymentLink` empty.

         ▶ PATH B — Plain static hosting (no server, no secret key on a box)
           You host the files anywhere. Stripe's own page collects the amount.
             1. Sign up free at https://stripe.com
             2. Dashboard → Payment Links → + New
             3. At "Select a product or service", choose
                "Customers choose what to pay"   ← do NOT add a product
             4. Title it "KPOT To Go", pick USD, set min $1 / max $500
             5. Create link → copy it (looks like https://buy.stripe.com/abc123XYZ)
             6. Paste it into `paymentLink` below and save this file.
           The checkout screen then shows the exact total with a one-tap Copy
           button so nobody mistypes it.

         Either way, until it is configured guests only ever see "Pay at
         Counter" — the online option stays hidden, so nothing is ever broken.
         ================================================================ */
      enabled: true,
      n: 'Pay Online',
      /* Apple Pay / Google Pay are NOT separate options on OUR page — they are
         buttons that Stripe's own checkout page adds *inside* the card form,
         and only when the guest's browser + device support them. So the copy
         below says "card", which is what the guest reliably sees here.
         To actually turn them on, see the Apple Pay / Google Pay note in
         admin.html → "Turn on card payments". */
      d: 'Credit / Debit card',
      paymentLink: '',         // ← PATH B only. e.g. 'https://buy.stripe.com/xxxxxxxx'
      /* PATH A needs no value here: the bundled server is found automatically
         at /api/checkout. Only set this if the checkout endpoint is hosted
         somewhere else, e.g. 'https://your-api.example.com/api/checkout'. */
      createSessionUrl: ''
    },

    venmo: {
      enabled: false,
      n: 'Venmo',
      d: 'Pay with your Venmo balance',
      handle: ''               // e.g. 'kpot-togo'
    },

    zelle: {
      enabled: false,
      n: 'Zelle',
      d: 'Bank-to-bank transfer',
      recipient: ''            // e.g. 'orders@kpot.com'
    }
  },

  /* ---- Pickup and delivery are prepaid — there is nothing to configure ---
     The owner's rule (2026-10-22, final): every PICKUP and every DELIVERY
     order must be PAID before it is sent to the kitchen, and pay-at-counter
     is not accepted on either. A pickup guest is not in the building — there
     is no table to walk past and nobody to collect from afterwards — so an
     unpaid pickup order is food cooked for someone who may never arrive. A
     delivery leaves the building entirely. Only a guest sitting at a table
     may run a tab.

     Two arms enforce it, both in server.js, and neither has a threshold or a
     switch:
       * pay-at-counter is refused on pickup and delivery at order creation
         (counterChannelVerdict) — the guest pays online at checkout;
       * the order cannot reach 'preparing' until the money is confirmed
         (kitchenHold) — not by the kitchen automation, and not by a staff tap
         on PREPARING.

     There is deliberately no `prepayOver` and no `allowCounter` any more: a
     rule with a threshold is a rule that lets the expensive order through,
     and a switch to turn it off is the switch somebody flips at 9pm when the
     card terminal is down — exactly when it matters. The one number that
     still exists, payment.counter.maxTotal below, is a TABLE-TAB ceiling,
     because dine-in is the only channel left that can pay at the counter. */

  /* ---- Where the order goes --------------------------------------------
     The order ticket is ALWAYS shown on screen (guest shows it at the counter).
     Optionally, also push it somewhere automatically:
       webhookUrl  → any endpoint that accepts POST JSON (Zapier, Make, n8n,
                     your own API, a Google Sheet script, etc.)
       email       → opens the guest's mail app pre-filled to this address
       whatsapp    → opens WhatsApp with the ticket pre-filled to this number
     ---------------------------------------------------------------------- */
  dispatch: {
    webhookUrl: '',            // e.g. 'https://hooks.zapier.com/hooks/catch/.../'
    email: '',                 // e.g. 'orders@kpot.com'
    whatsapp: '',              // e.g. '15551234567'  (country code, digits only)
    /* New-order email alerts. When set, the server emails this address every
       time a guest places an order. Requires GMAIL_USER + GMAIL_APP_PASSWORD
       env vars (or secrets.local.json) on the server. Leave blank to disable. */
    notifyTo: 'kpotexpress@gmail.com' // e.g. 'owner@kpot.com'
  },

  /* ---- Kitchen printer -------------------------------------------------
     When staff tap PREPARING on the board, a kitchen ticket is queued and a
     small program on a PC in the restaurant sends it to the printer.

     The printer's address does NOT live here — it is configured on that PC
     (print-agent/config.json), because this file runs in the cloud and has no
     way to reach a printer on your shop's network.

     What lives here is the ticket itself:
       paper  '80' = 80mm roll — the usual kitchen size
              '58' = 58mm roll — the small handheld ones
       cols   How many characters the printer can ACTUALLY print across.
              printer.js defaults to 48 (80mm) / 32 (58mm) when this is left
              blank, but real printers have fixed mechanical margins that eat
              into the paper. The Toast TP200 in this shop, for instance, has
              7mm + 9mm of unreachable paper, so only ~42 characters fit —
              leave cols at the default and every line wraps, the two-column
              totals shred themselves, and "DINE-IN" prints as "D" + "INE-IN".
              Set this once for your printer and forget it.
       cut    true  = tell the printer to cut the paper after each ticket
              false = leave it (some cheap printers have no cutter)

     Set `enabled: false` to stop queueing tickets entirely; the board then
     simply shows no printer state and nothing is sent.
     ---------------------------------------------------------------------- */
  printer: {
    enabled: true,
    paper: '80',
    /* Real printable width of THIS printer, characters. printer.js falls back
       to its own default (48 for 80mm, 32 for 58mm) when this is left null.
       The Toast TP200 in the shop has 7mm + 9mm fixed margins, so 42 is the
       honest number. Set wrong and the two-column rows fall apart on paper. */
    cols: 42,
    cut: true
  },

  /* ---- Feature flags --------------------------------------------------- */
  features: {
    qrTableNumbers: true,      // read ?table=12 from the QR link
    orderAgain: true,          // remember last order on this device
    allergenNotes: true,       // let guests add a note per item
    orderNotes: true,          // let guests add a note to the whole order
    sounds: true,              // little confirmation chime
    /* Store-credit codes (the LUCKY 66 prize, and any code the owner issues
       by hand) are spent in the checkout sheet. The server enforces them
       whatever this says — this only decides whether the guest sees the box. */
    storeCredit: true
  },

  /* ---- LUCKY 66 giveaway -------------------------------------------------
     FREE sweepstakes: e-mail verified entry, one entry per person, 200 per
     round, one $66 store-credit code. No purchase, payment, tip or subscription is
     ever required or requested.

     ⛔ DISABLED BY DEFAULT. `enabled:false` keeps the customer page, the
     banner and every public API endpoint dark. Turning it on is a two-key
     decision, not a deploy detail:

        1. the Georgia legal review in LUCKY66_OFFICIAL_RULES.md is signed off
        2. the owner says go

     The draw and the prize issuance additionally refuse to run while this is
     off (see giveaway-api.js). A runtime switch lives in store.local.json
     (giveaway.enabled) so the owner can flip it without a redeploy; the file
     wins over this static default, and the KPOT_GIVEAWAY_ENABLED test seam
     wins over both.

     Do NOT re-add the "no minimum" or "no tips" banners to this feature —
     those marketing lines were ruled out by the owner (2026-10-19); the
     giveaway copy is licensed from the Official Rules only. */
  giveaway: {
    enabled: false,
    maxEntries: 200,
    prizeValue: 66,
    prizeDesc: 'KPOT EXPRESS $66 Store-Credit Code',
    /* Bump this any time the Official Rules text changes in a way that
       matters to entrants — a stale acknowledgement must re-confirm. */
    rulesVersion: 'LUCKY66-2026-10-20',
    /* Version of the short eligibility/privacy notice shown at entry. */
    noticeVersion: '1',
    verifyHours: 24,
    pagePath: '/giveaway.html'
  },

  /* ---- Brand ----------------------------------------------------------- */
  brand: {
    red: '#D7263D',
    redDark: '#A81B2E',
    black: '#111014',
    cream: '#F7F1E6',
    gold: '#E8B44A'
  }
};

/* Public URL this menu is served from.
   Leave EMPTY and admin.html will auto-detect the live address from the browser
   (best choice — it can never go stale after a re-publish).
   Only fill it in if you want to force a specific URL. */
const PUBLIC_URL = '';
