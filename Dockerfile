# ═══════════════════════════════════════════════════════════════════
# CP2 — Containerization (production-ready)
#
#   Stage `builder`: cài dependency vào một virtualenv ở /opt/venv.
#   Stage `runtime`: chỉ copy virtualenv + code (app/, utils/) sang một
#                    base slim sạch → image nhỏ, không mang theo pip cache.
#
#   - COPY requirements.txt + pip install TRƯỚC khi copy source: sửa code
#     không làm mất cache của layer cài thư viện.
#   - Chạy bằng user thường (uid 10001), không phải root.
#   - HEALTHCHECK gọi /health bằng urllib (image slim không có curl).
#   - Cổng đọc từ $PORT (Railway/Render tự gán), mặc định 8000.
#   - `exec` để uvicorn là PID 1 và nhận SIGTERM trực tiếp → graceful shutdown.
#   - Không có secret nào trong image: AGENT_API_KEY truyền lúc chạy.
#
# Build:  docker build -t day12-agent:multi .
#         docker images day12-agent
# So sánh với bản một stage ban đầu: docker build -f Dockerfile.single -t day12-agent:single .
# ═══════════════════════════════════════════════════════════════════

# ---------- Stage 1: builder ----------
FROM python:3.11-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ---------- Stage 2: runtime ----------
FROM python:3.11-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH"

RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /app --shell /usr/sbin/nologin app

WORKDIR /app

COPY --from=builder /opt/venv /opt/venv
COPY --chown=app:app app/ ./app/
COPY --chown=app:app utils/ ./utils/

USER app

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:${PORT:-8000}/health', timeout=3)" || exit 1

CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
