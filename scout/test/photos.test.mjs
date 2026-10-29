import assert from "node:assert/strict";
import { test } from "node:test";
import { readGps } from "../public/photos.js";

/** A JPEG start with an EXIF block holding a GPS position, in either byte order. */
function jpegWithGps({ little, lat, lng, latRef, lngRef }) {
  const tiff = Buffer.alloc(128);
  const w16 = (o, v) => (little ? tiff.writeUInt16LE(v, o) : tiff.writeUInt16BE(v, o));
  const w32 = (o, v) => (little ? tiff.writeUInt32LE(v, o) : tiff.writeUInt32BE(v, o));
  tiff.write(little ? "II" : "MM", 0, "latin1");
  w16(2, 42);
  w32(4, 8);
  // IFD0: one entry pointing to the GPS IFD at 26.
  w16(8, 1);
  w16(10, 0x8825), w16(12, 4), w32(14, 1), w32(18, 26);
  w32(22, 0);
  // GPS IFD: refs and degrees/minutes/seconds as rationals at 80 and 104.
  w16(26, 4);
  const entry = (i, tag, type, count, value) => {
    const e = 28 + i * 12;
    w16(e, tag), w16(e + 2, type), w32(e + 4, count);
    if (typeof value === "string") tiff.write(value, e + 8, "latin1");
    else w32(e + 8, value);
  };
  entry(0, 1, 2, 2, latRef);
  entry(1, 2, 5, 3, 80);
  entry(2, 3, 2, 2, lngRef);
  entry(3, 4, 5, 3, 104);
  const rationals = (at, [d, m, s100]) => {
    w32(at, d), w32(at + 4, 1), w32(at + 8, m), w32(at + 12, 1), w32(at + 16, s100), w32(at + 20, 100);
  };
  rationals(80, lat);
  rationals(104, lng);
  const exif = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const size = Buffer.alloc(2);
  size.writeUInt16BE(exif.length + 2);
  const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), size, exif, Buffer.from([0xff, 0xd9])]);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
}

test("reads GPS from EXIF in both byte orders", () => {
  for (const little of [false, true]) {
    const gps = readGps(jpegWithGps({ little, lat: [51, 3, 1548], lng: [3, 43, 264], latRef: "N", lngRef: "E" }));
    assert.ok(Math.abs(gps.lat - 51.0543) < 1e-4, `lat ${gps.lat}`);
    assert.ok(Math.abs(gps.lng - 3.7174) < 1e-4, `lng ${gps.lng}`);
  }
});

test("south and west are negative", () => {
  const gps = readGps(jpegWithGps({ little: true, lat: [33, 52, 0], lng: [151, 12, 0], latRef: "S", lngRef: "W" }));
  assert.ok(gps.lat < 0 && gps.lng < 0);
});

test("no EXIF or not a JPEG gives null", () => {
  const plain = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9]);
  assert.equal(readGps(plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.length)), null);
  assert.equal(readGps(new ArrayBuffer(2)), null);
  const png = Buffer.from("\x89PNG\r\n\x1a\n", "latin1");
  assert.equal(readGps(png.buffer.slice(png.byteOffset, png.byteOffset + png.length)), null);
});
