# Live detection models

Loaded by `src/features/live/detector.worker.ts` when an operator turns on live
detection in a camera panel. They run in the browser (WebGPU, or WebAssembly on
the CPU) on the frames the panel is already playing — no server involved.

| File | What it is | Source | Licence |
|---|---|---|---|
| `vehicle-yolo11n-640.onnx` | Vehicles (COCO car, motorcycle, bus, truck) | Ultralytics YOLO11n, exported with ultralytics 8.4.90: `imgsz=640, nms=True, simplify=True, opset=17` | AGPL-3.0 |
| `plate-yolov9t-384.onnx` | Licence plates | open-image-models `yolo-v9-t-384-license-plate-end2end` — the same detector the batch pipeline uses | MIT |
| `ocr-cct-xs-v2.onnx` | Plate characters (10 slots, `0-9 A-Z _`) | fast-plate-ocr `cct-xs-v2-global-model` | MIT |

## Why these

Measured on this estate's 50 stored sightings, labelled by the full pipeline:

- **Vehicles.** Of the vehicles large enough for a plate to be read (wider than
  140 px), YOLO11n finds 83 of 93 and YOLO11s 85 of 93, against YOLO11m at
  1280 px. The small model costs a third of the download and half the time.
- **Characters.** Single-frame exact reads: PaddleOCR server 30/50 (the batch
  pipeline's model, ~80 MB), PaddleOCR mobile 20/50, cct-xs-v2 18/50 at
  4.6 ms, cct-s-v2 1/50. The v1 models cap plates at 9 characters, and most
  Indian plates have 10. Decoding under the Indian plate grammar lifts
  cct-xs-v2 from 54.5% to 65.9% per-character accuracy.
- **Gates.** Every correct read came from a plate at least 79 px wide. Correct
  reads sit at median confidence 0.91 and wrong ones at 0.76. So text is shown
  only when the plate is at least 70 px wide and confidence reaches 0.80; a
  0.80 gate kept 18 of the 19 correct reads.

The live reader is lighter than the batch pipeline and is labelled as such in
the interface. Recorded sightings in the registry still come from the full
pipeline.

## Integrity

```
e869b1d3242e35be…  vehicle-yolo11n-640.onnx
888397b96d761c89…  plate-yolov9t-384.onnx
8031afb5fdc6b4d8…  ocr-cct-xs-v2.onnx
```

The ONNX Runtime WebAssembly build is not committed: `scripts/copy-ort.mjs`
copies it from `node_modules` into `public/ort` before every dev and build.
