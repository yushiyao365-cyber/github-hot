import type { StarSample } from '../shared/types.js';

export function starTrend(samples: StarSample[], width = 240, height = 70) {
  const points = samples.filter(sample => Number.isFinite(Date.parse(sample.observedAt)) && Number.isSafeInteger(sample.stars) && sample.stars >= 0)
    .toSorted((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  if (points.length < 2) return null;
  const start = Date.parse(points[0].observedAt);
  const span = Date.parse(points.at(-1)!.observedAt) - start;
  if (span <= 0) return null;
  const minimum = Math.min(...points.map(point => point.stars));
  const maximum = Math.max(...points.map(point => point.stars));
  const coordinates = points.map(point => ({
    x: 6 + (Date.parse(point.observedAt) - start) / span * (width - 12),
    y: maximum === minimum ? height / 2 : height - 6 - (point.stars - minimum) / (maximum - minimum) * (height - 12),
  }));
  const line = coordinates.map(point => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
  return { points, coordinates, line, area: `6,${height} ${line} ${width - 6},${height}`, minimum, maximum };
}
