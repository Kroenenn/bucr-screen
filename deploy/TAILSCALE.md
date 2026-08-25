# Exposing the board over the public internet with Tailscale Funnel

**Goal:** make `http://localhost:3000` on the Pi (the dockerized departure
board) reachable as a public `https://…ts.net` URL, so it can be embedded
in an `<iframe>` in a Slidev deck hosted on GitHub Pages and viewed by
people on a completely different network (venue wifi, cellular, etc.),
with **zero client install** on their side.

Run every command in this document **on the Pi itself** (SSH in, or
directly on its console). None of it touches this repo or git.

## Two different things named "Tailscale" — don't mix them up

| | Plain Tailscale | **Tailscale Funnel** (what we want) |
|---|---|---|
| Reachable by | only devices joined to your tailnet | **anyone on the internet** with the URL |
| Viewer needs the Tailscale app? | yes | **no** |
| Cert | internal tailnet cert | real publicly-trusted Let's Encrypt cert |
| Use case here | ❌ presenter/audience aren't on your tailnet | ✅ this is the one we need |

Funnel is a feature built on top of Tailscale — you still install and log
in to regular Tailscale first, then turn Funnel on for one port.

---

## 1. Install Tailscale on the Pi

Raspberry Pi OS / Debian (which is what the Pi is running, per the
`node:22-bookworm-slim` base image used to build this app):

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

This adds Tailscale's apt repo and installs the `tailscaled` daemon + `tailscale` CLI.

## 2. Connect the Pi to your tailnet

```bash
sudo tailscale up
```

This prints a login URL, e.g.:

```
To authenticate, visit:

        https://login.tailscale.com/a/xxxxxxxxxxxx
```

Open that URL in **any browser, on any device** (your laptop/phone is
fine — it does not have to be the Pi) and sign in. A free personal
Tailscale account is enough for this.

Once authenticated, confirm the Pi shows up:

```bash
tailscale status
```

You should see a line for this machine, something like:

```
100.x.y.z    simovi84             you@example.com   linux   -
```

`simovi84` here is the Tailscale **machine name** — this is what forms
the public hostname later (`simovi84.<tailnet-name>.ts.net`). If Tailscale
picked a different name than expected, you can rename the machine in the
admin console (Machines → the machine → **⋯ → Edit machine name**), or
just use whatever name it actually assigned in step 5 below.

## 3. Enable the Funnel prerequisites in the admin console (do not skip)

Funnel needs three things enabled on the **tailnet**, not just the
device. All three are one-time, tailnet-wide settings.

1. Go to **https://login.tailscale.com/admin/dns** and confirm
   **MagicDNS** is enabled (it usually is by default on a new tailnet).
2. On the same DNS page, enable **HTTPS Certificates** ("Enable HTTPS"
   toggle). This is what lets Tailscale provision the real Let's Encrypt
   cert for `*.ts.net`.
3. Go to **https://login.tailscale.com/admin/acls** (Access Controls) and
   make sure the policy file includes a `nodeAttrs` grant for `funnel`.
   The default policy that ships with new tailnets already has this, but
   if it was edited, it needs to look like:

   ```json
   "nodeAttrs": [
     {
       "target": ["autogroup:member"],
       "attr":   ["funnel"],
     },
   ],
   ```

   Add that block (inside the top-level JSON object) if it's missing, and
   click **Save**.

**If you skip this step**, running `tailscale funnel` on the Pi will
refuse to start and print an error to the effect of:

```
Funnel not enabled for tailnet; see https://tailscale.com/kb/1223/tailscale-funnel
```

or, if HTTPS certs specifically aren't on:

```
HTTPS is not enabled for your tailnet; enable it at https://login.tailscale.com/admin/dns
```

The fix in both cases is step 3 (and 2) above — there is no CLI flag that
gets around it, it's an account-level setting.

## 4. Make sure the board is actually up on port 3000 before continuing

Funnel just forwards traffic — it doesn't help if there's nothing
listening. From the Pi:

```bash
docker compose ps
```

Confirm the `bucr-screen` service shows `Up` (and `healthy` once past its
40s start period). Then sanity check locally:

```bash
curl -sI http://localhost:3000/api/health
```

Expect `HTTP/1.1 200 OK`. If this fails, fix the container first —
Funnel will happily expose a broken/absent server to the whole internet.

## 5. Start the Funnel

Foreground (good for a first test — Ctrl+C stops it and leaves nothing
running):

```bash
tailscale funnel 3000
```

On success it prints the public URL, e.g.:

```
Available on the internet:

https://simovi84.<your-tailnet-name>.ts.net/
|-- proxy http://127.0.0.1:3000

Press Ctrl+C to exit.
```

For the actual presentation you want this **persistent** — surviving
terminal disconnects and, more importantly, surviving a Pi reboot.
Use the background form instead:

```bash
sudo tailscale funnel --bg --https=443 localhost:3000
```

This registers the Funnel config with `tailscaled` and detaches — no
foreground process to keep alive, and it comes back automatically after
`tailscaled` restarts (including after a full Pi reboot), because the
serve/funnel config is persisted by the daemon, not by your shell
session.

Verify it's actually running:

```bash
tailscale funnel status
```

Expected output looks like:

```
https://simovi84.<your-tailnet-name>.ts.net (Funnel on)
|-- / proxy http://127.0.0.1:3000
```

**To verify it survives a reboot:** `sudo reboot`, wait for the Pi to
come back, SSH in again, and re-run `tailscale funnel status` — it
should show the same config with no extra commands needed. (Also
recheck `docker compose ps`, since the board container needs to be
`restart: unless-stopped` — which it already is in `compose.yml` — to
come back on its own too.)

## 6. Get the exact URL to paste into the Slidev deck

```bash
tailscale funnel status
```

or

```bash
tailscale status
```

The hostname shown (`https://simovi84.<your-tailnet-name>.ts.net`) is
the final public URL. In the Slidev deck, replace the placeholder:

```
https://simovi84.CHANGEME.ts.net
```

with this exact value (including the trailing path if your iframe
targets a specific route, e.g. `https://simovi84.<tailnet>.ts.net/board`).

Note the tailnet name segment (`CHANGEME`) is specific to your Tailscale
organization — it's visible both in this URL and at the top of the admin
console.

## 7. Verify from a genuinely different network

This is the step that actually matters for the demo — don't just trust
`tailscale funnel status`.

From a phone on **cellular data** (wifi off), or any device that is not
on your LAN and not joined to your tailnet, open:

```
https://simovi84.<your-tailnet-name>.ts.net
```

in a normal browser tab. It should load the board with a valid padlock
(real Let's Encrypt cert, no security warnings). Then embed-test it —
open the actual GitHub Pages Slidev deck on that same off-network device
and confirm the iframe renders the board, not a blank frame (if it's
blank, check the browser console on that device for
`X-Frame-Options`/CSP framing errors — see Troubleshooting below).

You can also do a quick headless check from any machine:

```bash
curl -sI https://simovi84.<your-tailnet-name>.ts.net/api/health
```

Expect `HTTP/2 200`.

## 8. Tear down after the presentation

Funnel makes the board reachable by **anyone on the internet** with the
URL for as long as it's on — there's no auth in front of it. Turn it off
once you're done presenting:

```bash
tailscale funnel --bg off
```

or, to wipe the whole serve/funnel config (also removes any plain
`tailscale serve` rules you may have set):

```bash
tailscale serve reset
```

Confirm it's gone:

```bash
tailscale funnel status
```

should report no funnels configured. The Docker container can keep
running locally (`http://localhost:3000` on the LAN) — only the public
Funnel exposure is being removed.

---

## Troubleshooting

**`Funnel not enabled for tailnet` / `access denied: Funnel is not
available for your tailnet`**
The `nodeAttrs` → `funnel` grant is missing from the tailnet's ACL policy
(step 3). Fix it at https://login.tailscale.com/admin/acls, not on the
Pi.

**`HTTPS is not enabled for your tailnet`**
Turn on **HTTPS Certificates** at
https://login.tailscale.com/admin/dns (step 3, item 2). Cert
provisioning can take up to a minute or two after enabling; retry
`tailscale funnel --bg --https=443 localhost:3000` if the first attempt
fails right after turning it on.

**`tailscale funnel status` shows nothing, or the public URL times out**
- Confirm the board itself is up: `docker compose ps` and
  `curl -sI http://localhost:3000/api/health` on the Pi.
- Confirm `tailscaled` is running: `sudo systemctl status tailscaled`.
- Confirm the Pi is actually connected to the tailnet:
  `tailscale status` (not just "Stopped"/logged out).

**Public URL loads but returns a Tailscale error page instead of the
board**
The `localhost:3000` target in the funnel command must match the port
the board is actually published on — check `HOST_PORT` in the Pi's
`.env` (compose.yml uses `${HOST_PORT:-3000}:3000`; if `.env` overrides
`HOST_PORT` to something other than 3000, use that value in the
`tailscale funnel --bg --https=443 localhost:<HOST_PORT>` command
instead).

**Firewall**
Tailscale/Funnel traffic rides over Tailscale's own relays via outbound
connections the Pi initiates — you generally do **not** need to open any
inbound ports on your router/firewall for Funnel to work, unlike a
traditional port-forward. If it still doesn't work, check that nothing
local (e.g. `ufw`) is blocking `tailscaled`'s own traffic:
`sudo ufw status`.

**Security reminder**
While Funnel is on, the board is public with no authentication in
front of it. Keep it on only for the duration of the talk and turn it
off per step 8 afterward.
