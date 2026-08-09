#!/usr/bin/env bash
# Create the Radical Books Stripe product + prices (AUD) on the SAME account as
# Radical Movies / Sound. Sources the live key from radical-movies/.env so the
# secret never touches the shell history or the terminal. Prints only the IDs.
#
#   bash scripts/create-stripe.sh
set -euo pipefail

KEY="$(grep -E '^STRIPE_SECRET_KEY=' /Users/maverick/radical-movies/.env | head -1 | cut -d= -f2-)"
[ -z "$KEY" ] && { echo "STRIPE_SECRET_KEY not found in radical-movies/.env"; exit 1; }

echo "→ creating product 'Radical Books'…"
PROD=$(curl -s https://api.stripe.com/v1/products -u "$KEY:" \
  -d name="Radical Books" \
  -d description="Unlimited audiobooks and ebooks" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo "  product: $PROD"

echo "→ monthly A\$5…"
MONTHLY=$(curl -s https://api.stripe.com/v1/prices -u "$KEY:" \
  -d product="$PROD" -d unit_amount=500 -d currency=aud \
  -d "recurring[interval]"=month | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo "  STRIPE_PRICE_MONTHLY=$MONTHLY"

echo "→ annual A\$40…"
ANNUAL=$(curl -s https://api.stripe.com/v1/prices -u "$KEY:" \
  -d product="$PROD" -d unit_amount=4000 -d currency=aud \
  -d "recurring[interval]"=year | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo "  STRIPE_PRICE_ANNUAL=$ANNUAL"

echo
echo "Add to /opt/radical-books/.env on the VM:"
echo "  STRIPE_PRICE_MONTHLY=$MONTHLY"
echo "  STRIPE_PRICE_ANNUAL=$ANNUAL"
echo "Then create a webhook → https://books.theradicalparty.com/api/billing/webhook"
echo "(events: checkout.session.completed, customer.subscription.*, invoice.payment_succeeded)"
echo "and set STRIPE_WEBHOOK_SECRET + STRIPE_SECRET_KEY in the VM .env."
