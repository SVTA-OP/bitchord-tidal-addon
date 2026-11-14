// PLACEHOLDER source. Fill in search() and resolveStream() with a source you are
// entitled to use (your own library, a licensed API, etc.). Nothing else in the
// project needs to change.
//
// Track (returned from search):
//   { id, title, artist, album, duration /*seconds*/, artworkURL,
//     format /*"flac"|"mp3"|"aac"|"dash"*/, audioQuality /*e.g. "LOSSLESS"*/ }
//   Optional Dolby fields: atmos: true, audioModes: ["DOLBY_ATMOS"]
//
// Stream (returned from resolveStream, or null when the id is not found):
//   { url /*absolute https*/, codec, container,
//     manifest /*"none"|"hls"|"dash"*/, sampleRate, bitDepth, bitrate,
//     quality /*display label*/, encrypted: false }
//   Be accurate: BitChord checks the codec it actually decodes.

import { NotImplementedError } from "../handler.js";

export const id = "custom";

// Best option first. The value is what arrives as ?quality= on both routes.
export const qualityOptions = [
  { value: "lossless", label: "Lossless" },
  { value: "high", label: "High" },
  { value: "low", label: "Low" },
];

/** @returns {Promise<object[]>} */
export async function search(query, { quality, atmos }) {
  throw new NotImplementedError("custom provider: search() is not implemented");
}

/** @returns {Promise<object|null>} */
export async function resolveStream(trackId, { quality, atmos }) {
  throw new NotImplementedError("custom provider: resolveStream() is not implemented");
}
