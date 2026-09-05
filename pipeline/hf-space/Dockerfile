FROM python:3.11-slim

# ffmpeg captures the feed; libGL and libglib are what OpenCV links against and
# are absent from the slim image — without them `import cv2` fails at runtime,
# which is a confusing way to discover a missing system package.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg libgl1 libglib2.0-0 git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# The team pipeline is vendored at build time so the Space has no runtime
# dependency on GitHub being reachable.
RUN git clone --depth 1 \
    https://github.com/ayushtriapty88-hue/sentinel-gujarat-pipeline.git \
    /app/sentinel-gujarat-pipeline

COPY app.py sentinel_worker.py ./

# Hugging Face runs the container as a non-root user, so the model caches these
# libraries write to must live somewhere writable.
ENV SENTINEL_PIPELINE_DIR=/app/sentinel-gujarat-pipeline \
    HOME=/tmp \
    ULTRALYTICS_CONFIG_DIR=/tmp/ultralytics \
    PADDLE_PDX_CACHE_HOME=/tmp/paddlex \
    MPLCONFIGDIR=/tmp/mpl

EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
