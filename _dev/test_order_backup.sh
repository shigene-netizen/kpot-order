#!/bin/bash
# End-to-end test of the order export / backup feature.
# Boots the server on a scratch port, creates an order, then checks every path.

NODE="C:/Users/shige/.workbuddy-ai/binaries/node/versions/22.22.2-3/node.exe"
DIR="C:/Users/shige/WorkBuddy AI/2026-10-02-19-51-22/kpot-order"
PORT=8971
KEY="DeL93JJudHjA"

cd "$DIR" || exit 1

# Start the server with a scratch backup dir so we don't touch real backups.
export PORT
export ORDERS_BACKUP_DIR="$DIR/_dev/backup-test"
rm -rf "$ORDERS_BACKUP_DIR"
"$NODE" server.js > /tmp/kpot-srv.log 2>&1 &
SRV=$!

# Wait for it to come up.
for i in $(seq 1 30); do
  sleep 0.5
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://127.0.0.1:$PORT/api/health" 2>/dev/null)
  [ "$code" = "200" ] && break
done
echo "server up (health=$code)"
echo

echo "=== 1. 下单（模拟客人）==="
curl -s -X POST "http://127.0.0.1:$PORT/api/orders" \
  -H 'Content-Type: application/json' \
  -d '{"no":"","token":"test-export-001","orderType":"dinein","table":"7","payMethod":"counter","total":10.58,"customer":{"name":"Alex Chen","phone":"(555) 123-4567"},"items":[{"kind":"simple","groupId":"bubbletea","name":"Thai Milk Tea","qty":2,"unit":4.99}]}'
echo; echo

echo "=== 2. 导出 CSV（带 key，应 200 且是附件）==="
curl -s -D - -o /tmp/kpot-export.csv "http://127.0.0.1:$PORT/api/orders/export.csv" -H "X-Admin-Key: $KEY" | head -6
echo "--- CSV 内容 ---"
cat /tmp/kpot-export.csv
echo

echo "=== 3. 导出 JSON（带 key）==="
curl -s "http://127.0.0.1:$PORT/api/orders/export.json" -H "X-Admin-Key: $KEY" | head -c 400
echo; echo

echo "=== 4. 无 key 应被拒（401）==="
curl -s -o /dev/null -w "  export.csv  无key -> %{http_code}\n" "http://127.0.0.1:$PORT/api/orders/export.csv"
curl -s -o /dev/null -w "  export.json 无key -> %{http_code}\n" "http://127.0.0.1:$PORT/api/orders/export.json"
echo

echo "=== 5. 备份目录必须 404（不能从网上读到）==="
curl -s -o /dev/null -w "  /order-backups/            -> %{http_code}\n" "http://127.0.0.1:$PORT/order-backups/"
curl -s -o /dev/null -w "  /order-backups/orders-x.csv -> %{http_code}\n" "http://127.0.0.1:$PORT/order-backups/orders-2026-10-04.csv"
echo

echo "=== 6. 占位路由没有被破坏 ==="
curl -s -o /dev/null -w "  GET /api/orders (带key) -> %{http_code}\n" "http://127.0.0.1:$PORT/api/orders" -H "X-Admin-Key: $KEY"
curl -s -o /dev/null -w "  GET /api/orders/KP-xxx (不存在) -> %{http_code}\n" "http://127.0.0.1:$PORT/api/orders/KP-999999-999" -H "X-Admin-Key: $KEY"
echo

echo "=== 7. 启动时自动写了备份吗 ==="
ls -la "$ORDERS_BACKUP_DIR" 2>/dev/null || echo "  (无备份目录)"

echo
echo "=== 8. 关闭（SIGTERM）应再写一次备份 ==="
kill -TERM $SRV 2>/dev/null
sleep 2
ls -la "$ORDERS_BACKUP_DIR" 2>/dev/null

echo
echo "=== 9. 最终检查：备份文件内容 ==="
for f in "$ORDERS_BACKUP_DIR"/*; do
  [ -f "$f" ] || continue
  echo "  $(basename "$f")  ($(wc -c < "$f") bytes)"
done
echo
echo "=== 服务器日志 ==="
tail -15 /tmp/kpot-srv.log
