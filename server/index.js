import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

function hashStringToNumber(input) {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

function pseudoRandom(seed) {
  // Deterministic PRNG (Mulberry32)
  let a = seed + 0x6D2B79F5;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateSquare(centerLng, centerLat, sizeDeg) {
  const half = sizeDeg / 2;
  return [
    [centerLng - half, centerLat - half],
    [centerLng + half, centerLat - half],
    [centerLng + half, centerLat + half],
    [centerLng - half, centerLat + half],
    [centerLng - half, centerLat - half]
  ];
}

function generateBlobbyPolygon(centerLng, centerLat, baseRadiusDeg, rng) {
  const points = 12 + Math.floor(rng() * 8); // 12-19 points
  const coords = [];
  for (let i = 0; i < points; i++) {
    const angle = (i / points) * Math.PI * 2;
    const radius = baseRadiusDeg * (0.7 + rng() * 0.6); // vary radius 0.7x..1.3x
    const lng = centerLng + Math.cos(angle) * radius;
    const lat = centerLat + Math.sin(angle) * radius * (0.6 + rng() * 0.8); // slight lat squish
    coords.push([lng, lat]);
  }
  coords.push(coords[0]);
  return coords;
}

function approxAreaDeg2(coords) {
  // Shoelace formula over first ring
  if (!coords || coords.length < 4) return 0;
  let area = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const [x1, y1] = coords[i];
    const [x2, y2] = coords[i + 1];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area / 2);
}

function centroidOfRing(coords) {
  let sumLng = 0;
  let sumLat = 0;
  let n = coords.length;
  for (let i = 0; i < n; i++) {
    sumLng += coords[i][0];
    sumLat += coords[i][1];
  }
  return [sumLng / n, sumLat / n];
}

function ringBBox(coords) {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const [lng, lat] of coords) {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLng, minLat, maxLng, maxLat];
}

function bboxesOverlap(a, b) {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

function applyChaikinSmoothing(coords, iterations = 1) {
  let ring = coords;
  for (let it = 0; it < iterations; it++) {
    const smoothed = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const p0 = ring[i];
      const p1 = ring[i + 1];
      const q = [p0[0] * 0.75 + p1[0] * 0.25, p0[1] * 0.75 + p1[1] * 0.25];
      const r = [p0[0] * 0.25 + p1[0] * 0.75, p0[1] * 0.25 + p1[1] * 0.75];
      smoothed.push(q, r);
    }
    smoothed.push(smoothed[0]);
    ring = smoothed;
  }
  return ring;
}

function deg2ToHectares(coords) {
  const [clng, clat] = centroidOfRing(coords);
  const metersPerDegLat = 111320;
  const metersPerDegLng = Math.cos((clat * Math.PI) / 180) * 111320;
  let area = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const x1 = coords[i][0] * metersPerDegLng;
    const y1 = coords[i][1] * metersPerDegLat;
    const x2 = coords[i + 1][0] * metersPerDegLng;
    const y2 = coords[i + 1][1] * metersPerDegLat;
    area += x1 * y2 - x2 * y1;
  }
  const m2 = Math.abs(area / 2);
  return m2 / 10000; // hectares
}

function createUrbanBlock(centerLng, centerLat, rng) {
  const size = 0.01 + rng() * 0.04;
  const rect = generateSquare(centerLng, centerLat, size);
  const angle = (rng() - 0.5) * (Math.PI / 6);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const rotated = rect.map(([lng, lat]) => {
    const dlng = lng - centerLng;
    const dlat = lat - centerLat;
    const rlng = dlng * cos - dlat * sin;
    const rlat = dlng * sin + dlat * cos;
    return [centerLng + rlng, centerLat + rlat];
  });
  rotated.push(rotated[0]);
  return rotated;
}

function createFeaturesForCategory(category, rng, centerLng, centerLat, opts = {}) {
  const features = [];
  const clusters = opts.clusters ?? (1 + Math.floor(rng() * 2));
  const perClusterBase = opts.count ?? (4 + Math.floor(rng() * 4));
  const placedBBoxes = [];
  for (let c = 0; c < clusters; c++) {
    const clusterDx = (rng() - 0.5) * 0.8;
    const clusterDy = (rng() - 0.5) * 0.8;
    const clusterLng = centerLng + clusterDx;
    const clusterLat = centerLat + clusterDy;
    const perCluster = perClusterBase + Math.floor(rng() * 2); // vary slightly
    for (let i = 0; i < perCluster; i++) {
      // attempt a few placements to reduce overlap
      let attempts = 0;
      let lng = clusterLng, lat = clusterLat, ring;
      const maxAttempts = 8;
      while (attempts < maxAttempts) {
        const dx = (rng() - 0.5) * 0.22;
        const dy = (rng() - 0.5) * 0.22;
        lng = clusterLng + dx;
        lat = clusterLat + dy;
        let size;
        let baseRing;
        if (category === 'urban') {
          size = 0.015 + rng() * 0.04;
          baseRing = createUrbanBlock(lng, lat, rng);
        } else if (category === 'crops') {
          size = 0.02 + rng() * 0.05;
          baseRing = generateSquare(lng, lat, size);
        } else if (category === 'water') {
          size = 0.03 + rng() * 0.07;
          baseRing = generateBlobbyPolygon(lng, lat, size, rng);
          baseRing = applyChaikinSmoothing(baseRing, 1);
        } else if (category === 'forest') {
          size = 0.03 + rng() * 0.08;
          baseRing = generateBlobbyPolygon(lng, lat, size, rng);
          baseRing = applyChaikinSmoothing(baseRing, 2);
        } else {
          size = 0.02 + rng() * 0.06;
          baseRing = generateBlobbyPolygon(lng, lat, size, rng);
        }
        const bbox = ringBBox(baseRing);
        const overlaps = placedBBoxes.some((b) => bboxesOverlap(b, bbox));
        if (!overlaps || attempts > 4) {
          ring = baseRing;
          placedBBoxes.push(bbox);
          break;
        }
        attempts++;
      }

      let geom;
      if (category === 'water' && rng() > 0.6) {
        // occasional hole (island) for water bodies
        const inner = applyChaikinSmoothing(generateBlobbyPolygon(lng, lat, (ring ? 0.4 : 0.4) * 0.5, rng), 1);
        geom = { type: 'Polygon', coordinates: [ring, inner] };
      } else if (rng() > 0.85) {
        // occasional multipolygon
        const offset = 0.05 + rng() * 0.05;
        const ring2 = generateBlobbyPolygon(lng + offset, lat + offset, 0.6 * (ring ? 0.6 : 0.6), rng);
        geom = { type: 'MultiPolygon', coordinates: [[ring], [ring2]] };
      } else {
        geom = { type: 'Polygon', coordinates: [ring] };
      }

      const areaDeg2 = approxAreaDeg2(ring);
      const centroid = centroidOfRing(ring);
      const bbox = ringBBox(ring);
      const id = `${category}-${Math.floor(rng() * 1e9)}`;
      const props = {
        id,
        category,
        type: category,
        value: Math.round(rng() * 100),
        areaDeg2: Number(areaDeg2.toFixed(5)),
        areaHa: Number(deg2ToHectares(ring).toFixed(1)),
        centroidLatLng: [Number(centroid[1].toFixed(6)), Number(centroid[0].toFixed(6))],
        bbox,
        updatedAt: new Date(1700000000000 + Math.floor(rng() * 5e9)).toISOString(),
        confidence: Number((0.6 + rng() * 0.4).toFixed(2)),
        name: `${category} ${c + 1}-${i + 1}`
      };
      features.push({
        type: 'Feature',
        geometry: geom,
        properties: props
      });
    }
  }
  return features;
}

function parseQuery(query) {
  const normalized = (query || '').toLowerCase().trim();
  const categories = [];
  if (/(^|\b)(crop|crops|farm|agri|agriculture)\b/.test(normalized)) categories.push('crops');
  if (/(^|\b)(water|lake|river|reservoir|wetland)\b/.test(normalized)) categories.push('water');
  if (/(^|\b)(forest|tree|wood|woodland)\b/.test(normalized)) categories.push('forest');
  if (/(^|\b)(urban|building|city|house|settlement)\b/.test(normalized)) categories.push('urban');
  if (categories.length === 0) categories.push('generic');

  // Location hints
  const locationHints = {
    california: [36.5, -119.5],
    texas: [31, -99],
    india: [22.5, 79],
    europe: [50, 10],
    sahara: [23.5, 13],
    amazon: [-5, -63]
  };
  let center = null;
  for (const key of Object.keys(locationHints)) {
    if (normalized.includes(key)) {
      const [lat, lng] = locationHints[key];
      center = { lat, lng };
      break;
    }
  }
  // near:lat,lng
  const nearMatch = normalized.match(/near\s*(-?\d+\.?\d*),\s*(-?\d+\.?\d*)/);
  if (nearMatch) {
    center = { lat: parseFloat(nearMatch[1]), lng: parseFloat(nearMatch[2]) };
  }
  // count:n
  const countMatch = normalized.match(/count\s*[:=]\s*(\d{1,2})/);
  const count = countMatch ? Math.max(1, Math.min(20, parseInt(countMatch[1], 10))) : undefined;

  // bbox=minLng,minLat,maxLng,maxLat
  const bboxMatch = normalized.match(/bbox\s*[:=]\s*(-?\d+\.?\d*),\s*(-?\d+\.?\d*),\s*(-?\d+\.?\d*),\s*(-?\d+\.?\d*)/);
  const bbox = bboxMatch
    ? [parseFloat(bboxMatch[1]), parseFloat(bboxMatch[2]), parseFloat(bboxMatch[3]), parseFloat(bboxMatch[4])]
    : null;

  return { normalized, categories, center, count, bbox };
}

function synthesizeGeoJSON(query) {
  const normalized = (query || '').toLowerCase();
  const seed = hashStringToNumber(normalized || 'default');
  const rng = pseudoRandom(seed);
  const parsed = parseQuery(query);
  // Pick a deterministic center based on seed or parsed location
  const centerLng = parsed.center ? parsed.center.lng : -100 + rng() * 200; // -100..100
  const centerLat = parsed.center ? parsed.center.lat : -40 + rng() * 80; // -40..40
  const categories = parsed.categories;

  const colorByCategory = {
    crops: '#e53935',
    water: '#1e88e5',
    forest: '#43a047',
    urban: '#8e24aa',
    generic: '#546e7a'
  };

  const features = categories.flatMap((cat) => {
    const feats = createFeaturesForCategory(cat, rng, centerLng, centerLat, { count: parsed.count });
    return feats.map((f) => ({
      ...f,
      properties: {
        ...f.properties,
        color: colorByCategory[cat] || colorByCategory.generic
      }
    }));
  });

  // Optional bbox clip (very rough filter: keep features whose centroid falls inside)
  if (parsed.bbox) {
    const [minLng, minLat, maxLng, maxLat] = parsed.bbox;
    const inside = (coords) => {
      let sumLng = 0, sumLat = 0;
      for (const [lng, lat] of coords) { sumLng += lng; sumLat += lat; }
      const cx = sumLng / coords.length; const cy = sumLat / coords.length;
      return cx >= minLng && cx <= maxLng && cy >= minLat && cy <= maxLat;
    };
    const filtered = features.filter((f) => inside(f.geometry.coordinates[0]));
    if (filtered.length) {
      features.length = 0; features.push(...filtered);
    }
  }

  return {
    type: 'FeatureCollection',
    features,
    metadata: {
      center: [centerLat, centerLng],
      query: parsed.normalized,
      categories,
      colorByCategory
    }
  };
}

app.post('/api/query', (req, res) => {
  try {
    const { query } = req.body || {};
    const geojson = synthesizeGeoJSON(query);
    res.json(geojson);
  } catch (err) {
    res.status(500).json({ error: 'Failed to synthesize data' });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${PORT}`);
});


