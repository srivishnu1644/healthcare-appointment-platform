/**
 * Curated doctor portrait URLs (Unsplash, free to use under the Unsplash
 * license). Every ID below was verified live (HTTP 200 + image/jpeg) before
 * being added — never append an ID without checking it first.
 *
 * Assignment is deterministic per doctor id, so a doctor keeps the same photo
 * across reloads. Portrait vs landscape crop is handled with fit=crop.
 */
const PHOTOS = [
  "1559839734-2b71ea197ec2",
  "1612349317150-e413f6a5b16d",
  "1594824476967-48c8b964273f",
  "1622253692010-333f2da6031d",
  "1576091160399-112ba8d25d1d",
  "1579684385127-1ef15d508118",
  "1582750433449-648ed127bb54",
  "1651008376811-b90baee60c1f",
  "1638202993928-7267aad84c31",
  "1551601651-2a8555f1a136",
  // Team shot, used as the last resort rather than leaving one doctor out.
  "1537368910025-700350fe46c7",
];

const img = (id, w = 256) =>
  `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&q=80`;

/** Stable photo URL for a doctor, or null when there is nothing to key on. */
export function doctorPhotoUrl(doctor, w = 256) {
  const key = doctor?.id ?? doctor?.name;
  if (!key) return null;
  let h = 0;
  for (let i = 0; i < String(key).length; i += 1) {
    h = (h * 31 + String(key).charCodeAt(i)) >>> 0;
  }
  return img(PHOTOS[h % PHOTOS.length], w);
}

export default { doctorPhotoUrl };
