# Phiếu Phản Ánh — K4 Level 3A, Ngày 12

> **Bài làm cá nhân.** Trả lời bằng lời của chính bạn, dựa trên những gì bạn
> quan sát được khi chạy code — không sao chép đáp án của người khác.
>
> Cách trả lời: thay dòng placeholder *Câu trả lời của bạn* bằng câu trả lời.
> `grade.py` đếm số câu đã trả lời (15 điểm cho 10 câu).
>
> Họ và tên: Hoàng Quốc Việt  Mã học viên: 2A202602563

---

### Câu 1 — Fail fast (CP1)

Trong `Settings`, `agent_api_key` không có giá trị mặc định nên app chết ngay
khi khởi động nếu thiếu biến môi trường. Hãy mô tả một tình huống cụ thể mà
việc "chết sớm" này cứu bạn, so với việc để mặc định `"changeme"`.

> Tình huống này mình gặp thật khi deploy lên Render. Lần deploy đầu, biến
> `AGENT_API_KEY` bị để trống trên dashboard. Lúc đó `Settings` chỉ được đọc ở
> request đầu tiên, nên container vẫn khởi động, `/health` vẫn trả 200 và trang chat
> vẫn mở được — nhưng `/ready` và `/ask` đều trả 500. Chỉ nhìn health check thì
> tưởng mọi thứ ổn.
>
> Nếu có mặc định `"changeme"` thì còn tệ hơn: service chạy "bình thường" trên URL
> công khai với một khóa ai cũng đoán được, ai gửi `X-API-Key: changeme` cũng gọi
> được `/ask` và tiêu ngân sách của mình, mà không có lỗi nào để mình phát hiện.
>
> Mình đã sửa để app đọc cấu hình ngay trong `lifespan` lúc khởi động. Giờ thiếu
> khóa thì process thoát ngay (exit code 3) với log
> `{"event": "config_invalid", "fields": ["agent_api_key"]}`. Deploy bị đánh dấu
> thất bại, Render giữ bản cũ đang chạy, và mình biết lỗi trước khi có user nào gọi.

---

### Câu 2 — Log cho máy đọc (CP1)

Chạy service và gọi `/ask` vài lần. Dán một dòng log JSON bạn thu được, rồi
nêu **hai** việc bạn làm được với dòng log đó mà `print("đã trả lời xong")`
không làm được.

> Một dòng log thật khi chạy service ở máy và gọi `/ask` ba lần cùng user:
>
> ```json
> {"event": "ask_completed", "level": "info", "timestamp": "2026-09-28T08:40:58.173984+00:00", "user_id": "sv-02563", "tokens_in": 97, "tokens_out": 46, "cost_usd": 4.215e-05, "instance": "DESKTOP-G2UO1GK"}
> ```
>
> Hai việc làm được với dòng này mà `print("đã trả lời xong")` không làm được:
>
> 1. **Lọc và cộng dồn theo trường.** Ví dụ tổng `cost_usd` theo `user_id` trong
>    ngày, hoặc đếm số `ask_completed` theo `instance` để xem nginx chia tải có đều
>    giữa 3 replica không. Ba dòng mình thu được còn cho thấy `tokens_in` tăng dần
>    3 → 44 → 97 vì mỗi câu hỏi mang theo lịch sử — nhìn log là thấy chi phí mỗi
>    lượt đang tăng.
> 2. **Đặt cảnh báo tự động.** Platform log (Render, Datadog...) có thể báo động
>    khi xuất hiện `level = "error"` hoặc `event = "config_invalid"`, hay khi
>    `cost_usd` của một user vượt ngưỡng. Với một câu chữ tự do thì máy không biết
>    ai, bao nhiêu tiền, lúc nào.

---

### Câu 3 — Kích thước image (CP2)

Build cả hai phiên bản và ghi lại số đo thật:

```bash
docker build -f <Dockerfile-1-stage> -t agent:single .
docker build -t agent:multi .
docker images | grep agent
```

| Bản | Dung lượng |
|-----|-----------|
| 1 stage (bản đầu) | 1.19 GB (1190 MB) |
| Multi-stage | 209 MB |

Giải thích: phần dung lượng chênh lệch đó là những gì?

> Máy mình không cài Docker (không có Docker Desktop, không có WSL), nên mình
> đo trên runner Ubuntu của GitHub Actions — job `docker` trong
> `.github/workflows/ci.yml` build cả hai bản và in `docker images day12-agent`.
> Kết quả ở trên là số thật từ lần chạy đó (1 stage: 1.19GB, multi-stage: 209MB).
>
> Phần chênh ~1GB chủ yếu là **base image**: `python:3.11` bản đầy đủ là Debian
> kèm gcc, make, header để biên dịch C, git, curl và hàng trăm package hệ thống —
> những thứ chỉ cần lúc cài thư viện, không cần lúc chạy. `python:3.11-slim` bỏ hết
> phần đó. Ngoài ra bản 1 stage còn `COPY . .` (mang theo tests, tài liệu, file
> linh tinh) và giữ lại cache của pip. Bản multi-stage cài thư viện trong stage
> `builder`, rồi runtime chỉ copy sang virtualenv `/opt/venv` cùng hai thư mục
> `app/` và `utils/`.

---

### Câu 4 — Thứ tự lệnh trong Dockerfile (CP2)

Sửa một ký tự trong `app/main.py` rồi build lại. Với Dockerfile của bạn, những
layer nào được dùng lại từ cache, layer nào phải chạy lại? Nếu bạn đặt
`COPY . .` lên trước `RUN pip install` thì kết quả khác thế nào?

> Mình kiểm tra bằng job `docker` trong CI: thêm một dòng vào `app/main.py`
> rồi build lại với `--progress=plain`. Log cho thấy:
>
> - **Dùng lại cache:** tạo venv, `COPY requirements.txt`, `RUN pip install`,
>   `COPY --from=builder /opt/venv`, tạo user `app`, `WORKDIR /app`.
> - **Chạy lại:** chỉ `COPY app/ ./app/` và `COPY utils/ ./utils/` — hai layer
>   đứng sau chỗ file bị sửa.
>
> Docker so từng layer theo thứ tự; một layer thay đổi thì mọi layer sau nó phải
> build lại. Nếu đặt `COPY . .` trước `RUN pip install`, sửa một ký tự trong code
> cũng làm layer COPY đổi, kéo theo `pip install` chạy lại từ đầu mỗi lần build
> (tải lại toàn bộ thư viện, mất vài chục giây tới vài phút thay vì vài giây).

---

### Câu 5 — Vì sao không chạy bằng root (CP2)

Container mặc định chạy bằng root. Mô tả chuỗi sự kiện dẫn từ "một lỗ hổng
trong code Python của bạn" tới "kẻ tấn công có quyền cao trên máy host", và
lệnh `USER` cắt đứt chuỗi đó ở chỗ nào.

> Chuỗi sự kiện khi chạy bằng root:
>
> 1. Code hoặc một thư viện có lỗ hổng (ví dụ deserialize dữ liệu không tin cậy,
>    path traversal, hay một CVE trong dependency) cho kẻ tấn công chạy lệnh bên
>    trong container.
> 2. Lệnh đó chạy với quyền của process — nếu là root thì là uid 0, và uid 0 trong
>    container chính là uid 0 của kernel máy host (container chỉ là process bị cô
>    lập, không phải máy ảo).
> 3. Là root, kẻ tấn công sửa được mọi file trong container, cài thêm công cụ, và
>    nếu container có mount volume của host, có `docker.sock`, chạy `--privileged`
>    hoặc kernel có lỗi, thì thoát ra host với quyền root.
>
> Lệnh `USER app` cắt chuỗi này ngay ở bước 2: process chạy với uid 10001 không có
> đặc quyền. Kẻ tấn công vào được cũng chỉ là một user thường — không sửa được
> `/opt/venv` hay file hệ thống (các thư mục này thuộc root), không cài được gói,
> và nếu có thoát ra host thì cũng chỉ mang uid 10001, không phải root.

---

### Câu 6 — Cửa sổ trượt (CP3)

Rate limit của bạn dùng sliding window 60 giây. Nếu thay bằng cách đếm theo
phút đồng hồ (reset lúc giây 00), một người dùng có thể gửi tối đa bao nhiêu
request trong 2 giây liên tiếp khi hạn mức là 10/phút? Giải thích cách đạt được
con số đó.

> Tối đa **20 request trong khoảng 2 giây**. Cách đạt: gửi 10 request lúc
> 10:00:59 (vẫn trong phút 10:00, còn quota) rồi gửi thêm 10 request lúc 10:01:00
> hoặc 10:01:01 — bộ đếm đã reset về 0 lúc giây 00 của phút mới nên cũng được cho
> qua. Hai lô cách nhau 1–2 giây nhưng mỗi lô "đúng luật" theo phút đồng hồ của nó.
>
> Sliding window đếm số request trong 60 giây gần nhất tính từ thời điểm hiện
> tại, nên ở 10:01:01 nó vẫn thấy 10 request lúc 10:00:59 và trả 429. Mình thấy
> đúng hành vi này khi bấm "Gửi 12 request liên tiếp" trên giao diện: sau 2 câu
> hỏi trước đó, lô 12 request cho 8 × 200 rồi 4 × 429 — đúng 10 request trong một
> cửa sổ 60 giây.

---

### Câu 7 — Rate limit và cost guard (CP3)

Hai cơ chế này khác nhau ở điểm nào? Cho một tình huống mà rate limit cho qua
nhưng cost guard phải chặn, và một tình huống ngược lại.

> Rate limit giới hạn **số request trong một khoảng thời gian ngắn** (10 request
> / 60 giây / user) — chống spam và bảo vệ tài nguyên máy chủ. Cost guard giới hạn
> **số tiền cộng dồn trong tháng** (10 USD / user) — bảo vệ hóa đơn LLM. Một cái đếm
> lượt, một cái đếm tiền, và tiền của mỗi lượt không bằng nhau.
>
> - **Rate limit cho qua nhưng cost guard chặn:** một user gửi đều đặn 5 câu/phút —
>   không bao giờ chạm 10/phút — nhưng mỗi câu dài gần 2000 ký tự và hội thoại kéo
>   dài. Log của mình cho thấy `tokens_in` tăng 3 → 44 → 97 chỉ sau ba lượt vì lịch
>   sử được gửi kèm; cứ thế cả tháng thì tổng chi phí vượt 10 USD và cost guard trả
>   402 dù chưa lần nào bị 429.
> - **Rate limit chặn nhưng cost guard không cần chặn:** bấm "Gửi 12 request liên
>   tiếp" với câu hỏi ngắn — mỗi lượt chỉ tốn khoảng 0.00002–0.00004 USD, ngân sách
>   gần như còn nguyên, nhưng request thứ 11, 12 vẫn nhận 429 vì gửi quá nhanh.

---

### Câu 8 — /health khác /ready (CP4)

Nếu gộp hai endpoint làm một và cho nó kiểm tra Redis, chuyện gì xảy ra với cụm
3 container khi Redis mất kết nối 30 giây? Trả lời theo đúng thứ tự sự kiện.

> Giả sử gộp thành một endpoint có kiểm tra Redis, và orchestrator restart
> container khi endpoint đó lỗi 3 lần liên tiếp (mỗi 10 giây):
>
> 1. **Giây 0:** Redis mất kết nối.
> 2. **Giây 0–30:** cả 3 container cùng lúc trả lỗi health check, vì cả 3 cùng phụ
>    thuộc một Redis. Request đang vào cũng lỗi.
> 3. **Khoảng giây 30:** hết số lần thử, orchestrator đánh dấu **cả 3** unhealthy
>    và restart cả 3 cùng lúc. Lúc này không còn instance nào phục vụ — kể cả những
>    thứ không cần Redis như trang giao diện hay `/health`.
> 4. **Redis có lại quanh giây 30**, nhưng các container đang khởi động lại
>    (cold start). Nếu Redis chưa ổn hẳn, container mới vừa lên lại fail health
>    check và bị restart tiếp — vòng lặp restart, và cả 3 cùng lúc mở lại kết nối
>    tới Redis.
> 5. Kết quả: 30 giây Redis chập chờn biến thành sự cố dài hơn 30 giây trên toàn cụm.
>
> Tách ra thì: `/health` không đụng Redis nên vẫn 200 — không ai restart container.
> `/ready` trả 503 nên load balancer tạm ngừng đẩy traffic vào. Redis có lại →
> `/ready` 200 → traffic quay lại ngay, không có cold start nào.

---

### Câu 9 — Stateless (CP4)

Chạy `docker compose up --scale agent=3` rồi gọi `/ask` nhiều lần với cùng một
`X-User-Id`. Quan sát `history_length` trong response. Nếu lịch sử được lưu
trong một dict Python thay vì Redis, bạn sẽ thấy con số đó thay đổi thế nào?

> Máy mình không có Docker nên mình chạy thử nghiệm này trong job
> `compose-smoke` của GitHub Actions, bằng lệnh
> `docker compose -f docker-compose.yml -f docker-compose.scale.yml --profile lb up --scale agent=3`
> (file `docker-compose.scale.yml` bỏ port 8000 của agent để 3 replica không tranh
> nhau cổng, còn nginx nhận request ở cổng 8080). Gửi 6 request cùng
> `X-User-Id: ci-smoke`, kết quả thật:
>
> | Request | `history_length` | `instance` |
> |---|---:|---|
> | 1 | 0 | cbb7121388ae |
> | 2 | 2 | 590c7d5e2bf8 |
> | 3 | 4 | 1c811d10cc0c |
> | 4 | 6 | cbb7121388ae |
> | 5 | 8 | 590c7d5e2bf8 |
> | 6 | 10 | 1c811d10cc0c |
>
> nginx chia vòng tròn qua 3 container, nhưng `history_length` vẫn tăng đều 2 mỗi
> lượt, vì cả 3 cùng đọc/ghi một Redis.
>
> Nếu lịch sử nằm trong dict Python, mỗi container có dict riêng trong RAM, nên dãy
> số sẽ là **0, 0, 0, 2, 2, 2**: mỗi container chỉ nhớ những lượt rơi vào chính nó.
> Agent "mất trí nhớ" 2/3 cuộc hội thoại, và chỉ cần một container restart là phần
> nó nhớ cũng mất sạch.

---

### Câu 10 — Deploy thật (CP5)

Ghi lại **một** lỗi bạn gặp khi deploy lên cloud (build fail, health check
timeout, sai REDIS_URL, app không đọc `$PORT`...): thông báo lỗi là gì, bạn
tìm ra nguyên nhân bằng cách nào, và sửa ra sao?

> **Lỗi:** sau lần deploy đầu lên Render, `curl /health` trả 200 và trang chat
> vẫn mở được, nhưng `curl /ready` trả **500 Internal Server Error**, và
> `POST /ask` không có API key cũng trả **500** thay vì 401 như mong đợi.
>
> **Cách tìm nguyên nhân:** 500 chứ không phải 503, nên không phải do Redis chết
> (`ping()` đã bắt lỗi và trả 503). `/ask` không có key mà lại 500 nghĩa là lỗi xảy
> ra ngay trong `verify_api_key`, trước cả rate limit — chỗ đó chỉ gọi
> `get_settings()`. Mình tái hiện ở máy bằng cách chạy app mà **không** đặt
> `AGENT_API_KEY`: ra đúng 200 / 500 / 500 giống trên cloud. Nguyên nhân: mình tạo
> Blueprint trên Render trước khi merge `render.yaml` mới, nên Render dùng bản gốc
> có `AGENT_API_KEY` dạng `sync: false` (phải tự nhập giá trị lúc tạo); mình bỏ qua
> bước đó nên tab Environment chỉ có `LOG_LEVEL`, `MONTHLY_BUDGET_USD`,
> `RATE_LIMIT_PER_MINUTE`, `REDIS_URL` — biến `AGENT_API_KEY` hoàn toàn không tồn tại.
> App không chết lúc khởi động vì `Settings` chỉ được đọc ở request đầu tiên.
>
> **Cách sửa:** (1) đặt `AGENT_API_KEY` trong tab Environment của service trên
> Render rồi deploy lại; (2) sửa code để đọc cấu hình trong `lifespan` lúc khởi
> động — giờ thiếu biến bắt buộc thì container thoát ngay với log `config_invalid`
> chỉ ghi tên trường, deploy bị đánh dấu thất bại và Render giữ bản cũ, thay vì
> "Live" nhưng trả 500.
