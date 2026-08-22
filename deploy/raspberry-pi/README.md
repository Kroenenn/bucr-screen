# Raspberry Pi 5 kiosk setup

Turns a Pi 5 + display into an unattended `bucr-screen` kiosk: the app runs
in Docker, Chromium displays it full-screen, both restart automatically on
crash or reboot. **None of this has been validated on the actual hardware**
— written from standard Raspberry Pi OS / Docker / Chromium kiosk practice,
not tested on-device. Budget time to debug it before the event, and do the
burn-in test from PLAN.md's final checklist.

## 1. Flash the OS

Use Raspberry Pi Imager, **Raspberry Pi OS (64-bit) with desktop** (Bookworm
or later — Pi 5 needs 64-bit; the desktop variant is what gives you a
graphical session to run Chromium kiosk mode in). In the Imager's advanced
options (gear icon / Ctrl+Shift+X):

- Set hostname (e.g. `bucr-screen`)
- Enable SSH, set a password or key
- **Set the correct timezone (`America/Costa_Rica`) and locale.** The
  on-screen clock uses the browser's local time — if the Pi's clock is
  wrong, the kiosk clock and the "next arrival" countdowns will be wrong
  too, silently.
- Configure Wi-Fi if not using Ethernet

Boot the Pi, connect a display, confirm it reaches the desktop.

## 2. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"
# log out and back in (or reboot) for the group change to take effect
docker compose version   # confirm the compose plugin is present
```

## 3. Deploy the app

```bash
git clone https://github.com/simovilab/bucr-screen.git
cd bucr-screen
cp .env.example .env
nano .env   # set NUXT_OPERATION_MODE, NUXT_STOP_ID, NUXT_DATABUS_BASE_URL, etc.
docker compose up -d --build
curl http://localhost:3000/api/arrivals   # should return JSON, not an error
```

Confirm `docker compose up -d` also runs cleanly after a reboot — `restart:
unless-stopped` in `docker-compose.yml` handles the container itself, but
Docker's daemon needs to be enabled at boot too (it is, by default, after
the install script above — verify with `systemctl is-enabled docker`).

## 4. Kiosk mode (Chromium, autostart, no screen blanking)

Raspberry Pi OS Bookworm's desktop defaults to Wayland (`labwc`). The
autostart file below works for both the Wayland and the older X11 desktop.

**Disable screen blanking.** Wayland/labwc: edit
`~/.config/labwc/autostart` (create it if absent) and add near the top:

```bash
wlopm --off '*' &   # or: swayidle -w timeout 0 'true' if wlopm isn't available
```

If the Pi is instead running the classic X11 desktop, use `raspi-config` →
`Display Options` → `Screen Blanking` → `Disable`, or add to the same
autostart file:

```bash
xset s off -dpms &
```

**Launch Chromium in kiosk mode.** Copy [`kiosk.sh`](./kiosk.sh) somewhere on
the Pi (e.g. `/home/pi/bucr-screen/deploy/raspberry-pi/kiosk.sh`, i.e. leave
it where the repo clone puts it) and make it executable:

```bash
chmod +x deploy/raspberry-pi/kiosk.sh
```

Then autostart it. Two options — pick one:

### Option A: desktop autostart (simplest)

```bash
mkdir -p ~/.config/autostart
cp deploy/raspberry-pi/bucr-screen-kiosk.desktop ~/.config/autostart/
```

Edit the `Exec=` line in that file if you cloned the repo somewhere other
than `/home/pi/bucr-screen`. Reboot to test.

### Option B: systemd user service (restarts Chromium if it crashes)

```bash
mkdir -p ~/.config/systemd/user
cp deploy/raspberry-pi/kiosk.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now kiosk.service
sudo loginctl enable-linger "$USER"   # lets the user service start without an interactive login
```

Edit the `ExecStart=` path in `kiosk.service` first if the repo isn't at
`/home/pi/bucr-screen`.

## 5. Burn-in test

Leave it running for several hours (ideally overnight) before the event.
Watch for: memory growth in `docker stats`, the poll loop silently stopping,
Chromium's own memory creep (kiosk Chromium sessions are known to grow over
very long uptimes — a periodic Chromium restart, e.g. nightly via cron, is a
reasonable mitigation if this becomes an issue during burn-in).

## Recovery on event day

- Screen frozen / blank: `sudo systemctl --user restart kiosk.service`
  (Option B) or just power-cycle the Pi (Option A + Docker's `restart:
  unless-stopped` bring everything back on boot).
- Wrong/no data: `docker compose logs -f` on the Pi to see whether it's
  `real` mode failing over to schedule (expected, and fine) or something
  else. `docker compose restart` to force a clean reconnect.
- If Databús itself is unreliable at the venue: edit `.env`, set
  `NUXT_OPERATION_MODE=fake`, `docker compose up -d` (no rebuild needed).
