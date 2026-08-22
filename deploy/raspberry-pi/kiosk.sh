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

exec chromium-browser \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  --autoplay-policy=no-user-gesture-required \
  --check-for-update-interval=31536000 \
  "$URL"
