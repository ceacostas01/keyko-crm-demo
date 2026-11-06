/**
 * Reparto en carriles para citas que se solapan.
 *
 * Sin esto, dos citas a la misma hora se dibujan una encima de otra y la
 * agenda parece rota. Cada grupo de citas conectadas por solapamiento se
 * reparte en carriles y se pinta en paralelo.
 */

export type LaneInput = {
  id: string;
  start: number;
  end: number;
};

export type LanePlacement = {
  lane: number;
  lanes: number;
};

export function assignLanes(items: readonly LaneInput[]): Map<string, LanePlacement> {
  const result = new Map<string, LanePlacement>();
  if (items.length === 0) return result;

  const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end);

  // 1. Agrupar en clusters de solapamiento transitivo.
  const clusters: LaneInput[][] = [];
  let current: LaneInput[] = [];
  let clusterEnd = Number.NEGATIVE_INFINITY;

  for (const item of sorted) {
    if (current.length > 0 && item.start >= clusterEnd) {
      clusters.push(current);
      current = [];
      clusterEnd = Number.NEGATIVE_INFINITY;
    }
    current.push(item);
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  if (current.length > 0) clusters.push(current);

  // 2. Dentro de cada cluster, el primer carril libre.
  for (const cluster of clusters) {
    const laneEnds: number[] = [];
    const placement = new Map<string, number>();

    for (const item of cluster) {
      let lane = laneEnds.findIndex((end) => end <= item.start);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(item.end);
      } else {
        laneEnds[lane] = item.end;
      }
      placement.set(item.id, lane);
    }

    const lanes = laneEnds.length;
    for (const item of cluster) {
      result.set(item.id, { lane: placement.get(item.id) ?? 0, lanes });
    }
  }

  return result;
}

export type Overlap = {
  id: string;
  start: number;
  end: number;
  minutes: number;
};

/** Solapamientos de un intervalo contra una lista, en minutos. */
export function overlapsWith(
  target: { id?: string; start: number; end: number },
  others: readonly LaneInput[],
): Overlap[] {
  const found: Overlap[] = [];

  for (const other of others) {
    if (target.id && other.id === target.id) continue;
    const start = Math.max(target.start, other.start);
    const end = Math.min(target.end, other.end);
    if (end <= start) continue;
    found.push({ id: other.id, start: other.start, end: other.end, minutes: end - start });
  }

  return found.sort((a, b) => a.start - b.start);
}
