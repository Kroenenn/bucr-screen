#!/bin/sh
# Launches Chromium pointed at the local bucr-screen container in kiosk mode.
# Waits for the app to actually respond first, so Chromium doesn't land on
# a connection-refused error page during boot before Docker has finished
# starting the container.

URL="${BUCR_SCREEN_URL:-http://localhost:3000}"

echo "Waiting for $URL to respond..."
until curl -fs -o /dev/null "$URL"; do
  sleep 1
done

# Chromium writes its cache continuously. On a Pi booting off a microSD
# that's a steady write load for data we never need to survive a reboot, so
# point it at /dev/shm (tmpfs, i.e. RAM). The Pi 5 here has 8 GB; a 64 MB
# cache cap is nothing against that and spares the card.
CACHE_DIR="/dev/shm/chromium-cache"
mkdir -p "$CACHE_DIR"

exec chromium-browser \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  --autoplay-policy=no-user-gesture-required \
  --check-for-update-interval=31536000 \
  --disk-cache-dir="$CACHE_DIR" \
  --disk-cache-size=67108864 \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  "$URL"
