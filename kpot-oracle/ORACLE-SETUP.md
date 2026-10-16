# KPOT To Go — going live on Oracle Cloud (Always Free)

Truly free, forever. It does need a credit card for identity verification, but
Always Free resources are not charged.

Budget **1–2 hours**, and expect one frustrating step (see "Out of host
capacity" below). Everything after the virtual machine exists is one command.

---

## Step 0 — create a GitHub repo for the code (2 min)

The installer pulls the app from GitHub, so it has to live there first.

1. https://github.com/new
2. Name: **`kpot-order`**
3. **Public** is fine and simplest — I have verified the repo contains **no
   keys, no orders, no customer data** (they are all excluded; only the
   templates are committed).
4. Leave it completely empty (no README, no .gitignore, no license).
5. Create it, then tell me — I push the code.

---

## Step 1 — sign up for Oracle Cloud

1. https://www.oracle.com/cloud/free/
2. Pick your **home region** carefully — it cannot be changed later. Choose one
   near you (e.g. `US East (Ashburn)` or `US Midwest (Chicago)`).
3. Enter your card. It is a verification hold, not a charge.
4. When it asks, choose the **Always Free** account (do **not** upgrade to paid).

---

## Step 2 — create the virtual machine

1. Console → **Compute → Instances → Create instance**
2. Name: `kpot`
3. **Shape → Edit → Change shape**:
   - Series: **Ampere** (ARM)
   - Shape: **`VM.Standard.A1.Flex`**
   - OCPU: **2**, Memory: **12 GB**  ← the current Always Free ceiling
     (Oracle cut this from 4/24 in June 2026; 2/12 is still far more than
     this app needs)
4. **Image**: Ubuntu 22.04 (or 24.04). Keep the defaults.
5. **Networking**: keep the defaults, and make sure **Assign a public IPv4
   address** is on. **Write down that IP.**
6. **Add SSH keys**: choose "Generate a key pair" and **download both the
   public and the private key**. You cannot get the private key later.
7. Create.

### ⚠️ "Out of host capacity" — the annoying bit

Very common on the free ARM shape. It means no free machines in that region
right now. What works:

- Retry every 15–30 minutes (capacity appears in waves)
- Try a different **Availability Domain** in the same region
- Try another region entirely (if you have not locked your home region yet)
- Fall back to the **AMD** shape (`VM.Standard.E2.1.Micro`, 1 OCPU / 1 GB) —
  also Always Free and enough for this app, though slower

Do not pay for anything to get around this.

---

## Step 3 — open the ports (easy to miss)

Oracle blocks traffic by default at the network level, in addition to the
machine's own firewall.

1. Instance → **Primary VNIC → Subnet → Security List → Add Ingress Rules**
2. Add two rules (both with Source CIDR `0.0.0.0/0`):
   - Destination port range **`80`**, protocol TCP
   - Destination port range **`443`**, protocol TCP
3. (Port 22 for SSH should already be there.)

---

## Step 4 — connect to the machine

On Windows, open **PowerShell** (not Command Prompt):

```powershell
ssh -i C:\path\to\your-private-key.key ubuntu@YOUR.PUBLIC.IP
```

If Windows complains the key is too open: right-click the `.key` file →
Properties → Security → Advanced → disable inheritance → remove all users
except you.

If `ssh` is missing, install "OpenSSH Client" from Windows Settings →
Optional features, or use [MobaXterm](https://mobaxterm.mobaxterm.com/) (free,
and it has a built-in file browser).

---

## Step 5 — run the installer (one command)

Once you are in:

```bash
curl -fsSL https://raw.githubusercontent.com/shigene-netizen/kpot-order/main/kpot-oracle/setup-kpot.sh -o setup-kpot.sh
sudo bash setup-kpot.sh
```

(If the script is not in the repo yet, I will give you a two-line alternative.)

It will:

- install Node.js and Caddy
- put the app in `/opt/kpot`
- put your data in `/var/lib/kpot` (survives reboots and redeploys)
- start it as a service that comes back after a reboot
- ask you for **one** thing: your Stripe secret key
- generate the admin key and the print key, and **print them at the end**

**Copy those two keys down.** The print key goes into the kitchen PC.

---

## Step 6 — point the domain at it

In Squarespace (Domains → kpotexpress.com → DNS → Custom Records):

| Type | Host | Value |
|---|---|---|
| **A** | `order` | your Oracle public IP |

Do **not** touch the existing `www` record — it stays as it is.

Wait a few minutes for DNS, then:

```
https://order.kpotexpress.com/api/health     →  {"ok":true}
```

Caddy fetches the HTTPS certificate by itself once DNS resolves. If the first
try fails, wait 5 minutes and reload the page.

---

## Step 7 — tell me it's up

I then do the last two things:

1. Point `target.js` at `https://order.kpotexpress.com` (one line, then push)
2. Your **existing printed QR codes start going to the new machine** — no
   reprint, because they point at the redirect layer, not at the server.

---

## Step 8 — update the kitchen PC

On the shop PC: `print-agent/config.json` → set `"printKey"` to the print key
the installer showed you, confirm `printerHost`, restart `start.bat`.

---

## Day-to-day

```bash
sudo systemctl status kpot          # is it running?
sudo journalctl -u kpot -f          # live logs
sudo bash /opt/kpot/update.sh       # (optional) pull new code and restart
```

Backups: `/var/lib/kpot/orders.local.json` is your live order board. Copy it
off the machine occasionally.

## If it all goes wrong

Nothing you do here can break the shop: the current system keeps running until
you tell me to switch `target.js`. Switching back is one line.
