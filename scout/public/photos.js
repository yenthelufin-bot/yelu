// Reference photos: read GPS from EXIF, and shrink before uploading.

/**
 * The GPS position stored in a JPEG's EXIF data, or null. Phone cameras
 * usually store it; photos sent through chat apps or social media usually
 * have it removed.
 */
export function readGps(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset);
    const size = view.getUint16(offset + 2);
    // APP1 holding "Exif\0\0"
    if (marker === 0xffe1 && view.getUint32(offset + 4) === 0x45786966) return readExifGps(view, offset + 10);
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return null;
    offset += 2 + size;
  }
  return null;
}

function readExifGps(view, tiff) {
  const little = view.getUint16(tiff) === 0x4949;
  const u16 = (o) => view.getUint16(o, little);
  const u32 = (o) => view.getUint32(o, little);
  const entries = (ifd) => {
    const out = new Map();
    const count = u16(ifd);
    for (let i = 0; i < count; i++) {
      const e = ifd + 2 + i * 12;
      out.set(u16(e), { type: u16(e + 2), count: u32(e + 4), valueOffset: e + 8 });
    }
    return out;
  };
  try {
    const ifd0 = entries(tiff + u32(tiff + 4));
    const gpsPointer = ifd0.get(0x8825);
    if (!gpsPointer) return null;
    const gps = entries(tiff + u32(gpsPointer.valueOffset));
    const ref = (tag) => {
      const e = gps.get(tag);
      return e ? String.fromCharCode(view.getUint8(e.valueOffset)) : "";
    };
    const dms = (tag) => {
      const e = gps.get(tag);
      if (!e || e.count < 3) return null;
      const at = tiff + u32(e.valueOffset);
      const r = (i) => u32(at + i * 8) / (u32(at + i * 8 + 4) || 1);
      return r(0) + r(1) / 60 + r(2) / 3600;
    };
    const lat = dms(2);
    const lng = dms(4);
    if (lat === null || lng === null || (lat === 0 && lng === 0)) return null;
    return { lat: ref(1) === "S" ? -lat : lat, lng: ref(3) === "W" ? -lng : lng };
  } catch {
    return null;
  }
}

/** A JPEG of at most `maxSize` pixels on the long side, as base64. */
export async function prepareJpeg(file, maxSize = 1280) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`"${file.name}" kan de browser niet openen. Gebruik een JPG of PNG.`);
  }
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
