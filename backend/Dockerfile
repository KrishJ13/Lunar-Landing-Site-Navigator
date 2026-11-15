FROM python:3.12-slim AS datasets

WORKDIR /app
COPY kernels_manifest.json ./
COPY scripts/download_kernels.py scripts/fetch_dem.py ./scripts/
RUN python scripts/download_kernels.py

COPY lunar/__init__.py lunar/config.py ./lunar/
COPY lunar/dem ./lunar/dem
RUN python -m pip install --no-cache-dir "numpy>=1.26,<3" "certifi>=2024" \
    && python scripts/fetch_dem.py --tier starter

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1
WORKDIR /app

COPY pyproject.toml kernels_manifest.json ./
COPY lunar ./lunar
COPY lunar_sky ./lunar_sky
COPY lunar_skyline ./lunar_skyline
COPY --from=datasets /app/kernels ./kernels
COPY --from=datasets /app/data/dem ./data/dem

RUN python -m pip install --no-cache-dir . \
    && useradd --uid 10001 --create-home lunar \
    && install -d -o lunar -g lunar /app/data/dem/cache \
    && install -o lunar -g lunar /dev/null /app/data/dem/cache/.keep

USER lunar
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "lunar_skyline.app:app", "--host", "0.0.0.0", "--port", "8000"]
