#!/usr/bin/env bash
# External Derivatives Data Collection - Network Diagnostics
# Run this script to diagnose TLS connection failures

set -euo pipefail

echo "=== External Derivatives Network Diagnostics ==="
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# Test 1: Check proxy availability
echo "1. Testing proxy availability..."
if nc -z 127.0.0.1 7890 -w 2 2>/dev/null; then
  echo "   ✓ Proxy port 7890 is open"
else
  echo "   ✗ Proxy port 7890 is NOT accessible"
fi
echo ""

# Test 2: Test direct connection to Binance
echo "2. Testing direct connection to Binance API..."
if timeout 5 bash -c "echo > /dev/tcp/fapi.binance.com/443" 2>/dev/null; then
  echo "   ✓ Can reach fapi.binance.com:443"
else
  echo "   ✗ Cannot reach fapi.binance.com:443 (timeout or blocked)"
fi
echo ""

# Test 3: DNS resolution
echo "3. Testing DNS resolution..."
if host fapi.binance.com >/dev/null 2>&1; then
  echo "   ✓ DNS resolution works"
  host fapi.binance.com | head -3
else
  echo "   ✗ DNS resolution failed"
fi
echo ""

# Test 4: Check environment variables
echo "4. Checking proxy environment variables..."
echo "   HTTPS_PROXY: ${HTTPS_PROXY:-not_set}"
echo "   HTTP_PROXY: ${HTTP_PROXY:-not_set}"
echo "   NO_PROXY: ${NO_PROXY:-not_set}"
echo ""

# Test 5: Test with curl (no proxy)
echo "5. Testing with curl (no proxy)..."
if curl --noproxy '*' --connect-timeout 5 -I https://fapi.binance.com/fapi/v1/ping 2>&1 | grep -q "200 OK"; then
  echo "   ✓ Direct connection works"
else
  echo "   ✗ Direct connection failed"
fi
echo ""

# Test 6: Test with curl (with proxy)
echo "6. Testing with curl (with proxy)..."
if curl -x http://127.0.0.1:7890 --connect-timeout 5 -I https://fapi.binance.com/fapi/v1/ping 2>&1 | grep -q "200 OK"; then
  echo "   ✓ Proxy connection works"
else
  echo "   ✗ Proxy connection failed"
fi
echo ""

# Test 7: Check recent errors
echo "7. Recent collection errors..."
if [[ -f data/runtime/external_derivatives_data_collect.latest.json ]]; then
  echo "   Error count: $(jq -r '.errors | length' data/runtime/external_derivatives_data_collect.latest.json 2>/dev/null || echo 'unknown')"
  echo "   First error:"
  jq -r '.errors[0] | "   - \(.symbol)/\(.endpoint): \(.errorClass) - \(.error)"' data/runtime/external_derivatives_data_collect.latest.json 2>/dev/null || echo "   (no error details)"
else
  echo "   No report file found"
fi
echo ""

echo "=== Recommendations ==="
echo ""
if ! nc -z 127.0.0.1 7890 -w 2 2>/dev/null; then
  echo "⚠️  Proxy is not running. Start your proxy or disable it:"
  echo "   unset HTTPS_PROXY HTTP_PROXY"
fi

if ! timeout 5 bash -c "echo > /dev/tcp/fapi.binance.com/443" 2>/dev/null; then
  echo "⚠️  Cannot reach Binance API. Possible causes:"
  echo "   - Firewall blocking outbound HTTPS"
  echo "   - VPN/network restrictions"
  echo "   - Binance API is down (check status.binance.com)"
  echo "   - DNS issues"
fi

echo ""
echo "To disable proxy temporarily:"
echo "  unset HTTPS_PROXY HTTP_PROXY"
echo "  npm run scripts/collect_external_derivatives_data.ts"
echo ""
echo "To use a different proxy:"
echo "  export HTTPS_PROXY=http://your-proxy:port"
echo ""
