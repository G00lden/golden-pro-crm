@echo off
REM Golden Pro CRM - One-click Salla sync.
REM Triggers POST /api/integrations/salla/sync, then prints what was imported
REM by reading from GET /api/integrations/salla/orders.

setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0\.."

set "BASE_URL=%CRM_BASE_URL%"
if "%BASE_URL%"=="" set "BASE_URL=http://localhost:3000"

set "TOKEN=%CRM_BEARER_TOKEN%"
if "%TOKEN%"=="" set "TOKEN=local-dev:local-dev-owner"

echo === Golden Pro CRM: Salla sync ===
echo Base URL: %BASE_URL%
echo.

echo [1/3] Triggering manual sync...
curl -s -X POST -H "Authorization: Bearer %TOKEN%" -H "Content-Type: application/json" -d "{}" "%BASE_URL%/api/integrations/salla/sync" > .runtime\last-salla-sync.json
if errorlevel 1 (
  echo Sync request failed. Make sure the server is running on %BASE_URL%.
  exit /b 1
)
type .runtime\last-salla-sync.json
echo.
echo.

echo [2/3] Fetching synced orders snapshot...
curl -s -H "Authorization: Bearer %TOKEN%" "%BASE_URL%/api/integrations/salla/orders" > .runtime\last-salla-orders.json
if errorlevel 1 (
  echo Orders fetch failed.
  exit /b 1
)
node -e "const r=require('./.runtime/last-salla-orders.json'); console.log('linked:', r.linked); console.log('last_sync_status:', r.last_sync_status); console.log('last_sync_count:', r.last_sync_count); console.log('total stored orders:', r.total); if((r.orders||[]).length){console.log('most recent 3:'); for(const o of r.orders.slice(0,3)){console.log(' -', o.order_number||o.order_id||o.id, '|', o.customer_name||'?', '|', o.status||o.journey_status||'?');}}"
echo.

echo [3/3] Fetching mapped products snapshot...
curl -s -H "Authorization: Bearer %TOKEN%" "%BASE_URL%/api/integrations/salla/products" > .runtime\last-salla-products.json
if errorlevel 1 (
  echo Products fetch failed.
  exit /b 1
)
node -e "const r=require('./.runtime/last-salla-products.json'); console.log('total products in CRM:', r.total); console.log('mapped to Salla:', r.mapped_count); const list=(r.products||[]).filter(p=>p.mapped_to_salla).slice(0,5); for(const p of list){console.log(' -', p.name, '| sku:', p.sku||'-', '| used in orders:', p.order_usage_count);}"
echo.

echo Done. Reports saved under .runtime\ (last-salla-sync.json, last-salla-orders.json, last-salla-products.json).
endlocal
exit /b 0
