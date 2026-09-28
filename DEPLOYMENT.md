# Thông Tin Deploy — Checkpoint 5

> `pytest tests/test_cp5.py` đọc file này để tìm địa chỉ service và gọi thử.
>
> **Chỉ ghi TÊN biến môi trường, không có giá trị secret nào trong file này.**

## Thông Tin Học Viên

| Mục | Nội dung |
|-----|----------|
| Họ và tên | Hoàng Quốc Việt |
| Mã học viên | 2A202602563 |
| Repo | https://github.com/Catnip-harvest/K4-L3A-DAY12-HoangQuocViet-2A202602563-CloudServicesAndDeployment |

## Service

| Mục | Nội dung |
|-----|----------|
| Public URL | https://day12-agent-xbct.onrender.com |
| Platform | Render — web service `day12-agent` (Docker, free) + Key Value `day12-redis` (free), tạo bằng Blueprint từ `render.yaml` |
| Ngày deploy | 2026-09-28 |
| Giao diện | Mở Public URL trên trình duyệt → trang chat (nhập `AGENT_API_KEY` khi được hỏi) |

## Biến Môi Trường Đã Set Trên Cloud

Chỉ ghi tên biến và **nguồn giá trị**:

| Biến | Đã set | Ghi chú |
|------|--------|---------|
| `PORT` | ✅ | Render tự gán; Dockerfile đọc `${PORT:-8000}` |
| `AGENT_API_KEY` | ✅ | chuỗi ngẫu nhiên (`secrets.token_urlsafe(32)`), nhập tay trong tab Environment của service, không nằm trong repo |
| `REDIS_URL` | ✅ | connection string nội bộ của Render Key Value `day12-redis` (Blueprint `fromService`) |
| `RATE_LIMIT_PER_MINUTE` | ✅ | 10 |
| `MONTHLY_BUDGET_USD` | ✅ | 10.0 |
| `LOG_LEVEL` | ✅ | INFO |

Key Value dùng `ipAllowList: []`, nên chỉ service trong cùng tài khoản Render nối được qua mạng nội bộ, không mở ra Internet.

## Lệnh Kiểm Tra

```bash
URL=https://day12-agent-xbct.onrender.com

# 1. Liveness — mong đợi 200 {"status":"ok"}
curl -i $URL/health

# 2. Readiness — mong đợi 200 {"status":"ready"} (đã nối được Redis)
curl -i $URL/ready

# 3. Không có API key — mong đợi 401
curl -i -X POST $URL/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"Hello"}'

# 4. Có API key — mong đợi 200 kèm câu trả lời
curl -i -X POST $URL/ask \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $AGENT_API_KEY" \
  -H "X-User-Id: sv-test" \
  -d '{"question":"Deploy là gì?"}'

# 5. Rate limit — gọi 15 lần, những lần cuối phải trả 429
for i in $(seq 1 15); do
  curl -s -o /dev/null -w "%{http_code} " -X POST $URL/ask \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $AGENT_API_KEY" \
    -H "X-User-Id: sv-test" \
    -d '{"question":"test"}'
done; echo
```

## Kết Quả Chạy Thật

Chạy lúc 2026-09-28 (giờ UTC trong header `Date`), từ máy cá nhân:

```
$ curl -i https://day12-agent-xbct.onrender.com/health
HTTP/1.1 200 OK
Content-Type: application/json
{"status":"ok","service":"day12-agent","version":"1.0.0"}

$ curl -i https://day12-agent-xbct.onrender.com/ready
HTTP/1.1 200 OK
Content-Type: application/json
{"status":"ready","redis":true}

$ curl -i -X POST https://day12-agent-xbct.onrender.com/ask  (không có X-API-Key)
HTTP/1.1 401 Unauthorized
Content-Type: application/json
{"detail":"invalid or missing API key"}

$ curl -i -X POST https://day12-agent-xbct.onrender.com/ask  (X-API-Key sai)
HTTP/1.1 401 Unauthorized
{"detail":"invalid or missing API key"}
```

## Ảnh Chụp Màn Hình

- `screenshots/dashboard.png` — trang service `day12-agent` trên Render (deploy Live, repo và nhánh `main`)
- `screenshots/health.png` — `/health` mở trực tiếp trên trình duyệt
- `screenshots/chat-ui.png` — giao diện chat chạy trên Public URL: trạng thái "Sẵn sàng" (`/health` + `/ready`), hai lượt hỏi của cùng một user, `history_length` 0 → 2 nhờ Redis

## Sự cố khi deploy và cách xử lý

Lần đầu tạo Blueprint, Render đọc `render.yaml` gốc (lúc đó chưa merge bản mới), trong đó
`AGENT_API_KEY` là `sync: false` nên phải tự nhập. Biến này không được tạo, và vì `Settings`
chỉ được đọc ở request đầu tiên nên service vẫn lên, `/health` trả 200 nhưng `/ready` và `/ask`
trả 500. Đã xử lý bằng cách thêm `AGENT_API_KEY` trong tab Environment rồi deploy lại, và sửa
code để đọc cấu hình ngay lúc khởi động (PR #2): thiếu biến bắt buộc thì container thoát với
log `config_invalid`, không còn trường hợp "chạy nhưng trả 500". Chi tiết ở `exercises.md` câu 10.
