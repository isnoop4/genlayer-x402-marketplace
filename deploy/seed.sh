#!/usr/bin/env bash
# Seed Gen402 listings on studionet via the GenLayer CLI.
# Usage: CONTRACT=0x... ./deploy/seed.sh
# The deployer keystore password is read from ~/.genlayer/gen402-deploy.password
# (throwaway test account, kept outside this repo). Each `genlayer write`
# reads the password from stdin because the account is locked (no OS keychain
# in headless containers).
set -u
CONTRACT="${CONTRACT:?set CONTRACT=0x...}"
PW_FILE="$HOME/.genlayer/gen402-deploy.password"
if [ ! -f "$PW_FILE" ]; then echo "missing $PW_FILE" >&2; exit 2; fi

w() { # w <method> <args...>
  local method="$1"; shift
  echo "--- $method $*"
  cat "$PW_FILE" | timeout 300 genlayer write "$CONTRACT" "$method" --args "$@"
}

w create_listing \
  "BTC Price Snapshot" \
  "Live Bitcoin price in USD from the CoinGecko public API (simple price endpoint). Returns the current BTC/USD price as JSON." \
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd" \
  0 1000000000000000000

w create_listing \
  "Jakarta Weather Now" \
  "Current weather in Jakarta, Indonesia from the Open-Meteo public API: temperature, humidity, weather code and wind speed." \
  "https://api.open-meteo.com/v1/forecast?latitude=-6.2&longitude=106.8&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m" \
  1 100000000000000000

w create_listing \
  "Top Crypto Market Brief" \
  "Top-2 crypto market-cap brief (Bitcoin and Ethereum) from the CoinGecko public markets API: current price, market cap and 24h change." \
  "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin,ethereum&order=market_cap_desc&per_page=2&page=1" \
  2 2000000000000000000

echo "--- list_listings"
timeout 120 genlayer call "$CONTRACT" list_listings
