"""CP3 — Xác thực bằng API key.

Public URL = ai cũng gọi được. Không có lớp này, hóa đơn LLM của bạn do
người lạ quyết định.
"""

from __future__ import annotations

import secrets

from fastapi import Header, HTTPException, status

from .config import get_settings

ANONYMOUS_USER = "anonymous"


def verify_api_key(
    x_api_key: str | None = Header(default=None),
    x_user_id: str | None = Header(default=None),
) -> str:
    """Kiểm tra header ``X-API-Key``; trả về user_id nếu hợp lệ.

    Thiếu khóa hoặc sai khóa → 401. Khóa được so bằng
    ``secrets.compare_digest`` (luôn chạy hết chuỗi) thay vì ``==`` (dừng ở
    ký tự khác đầu tiên, làm lộ thông tin qua thời gian phản hồi — timing
    attack).

    Hợp lệ → trả ``x_user_id`` nếu client có gửi, ngược lại ``ANONYMOUS_USER``.
    user_id này là đơn vị để rate limit và tính chi phí.
    """
    expected_key = get_settings().agent_api_key
    key_is_valid = x_api_key is not None and secrets.compare_digest(
        x_api_key.encode("utf-8"), expected_key.encode("utf-8")
    )
    if not key_is_valid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid or missing API key",
        )
    return x_user_id or ANONYMOUS_USER
