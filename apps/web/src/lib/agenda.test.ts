import { describe, expect, it } from 'vitest';
import { assignLanes, overlapsWith } from './agenda';

describe('carriles de la agenda', () => {
  it('citas que no se tocan ocupan un solo carril', () => {
    const lanes = assignLanes([
      { id: 'a', start: 0, end: 60 },
      { id: 'b', start: 60, end: 120 },
      { id: 'c', start: 180, end: 240 },
    ]);

    expect(lanes.get('a')).toEqual({ lane: 0, lanes: 1 });
    expect(lanes.get('b')).toEqual({ lane: 0, lanes: 1 });
    expect(lanes.get('c')).toEqual({ lane: 0, lanes: 1 });
  });

  it('dos citas solapadas se reparten en dos columnas', () => {
    const lanes = assignLanes([
      { id: 'a', start: 0, end: 60 },
      { id: 'b', start: 30, end: 90 },
    ]);

    expect(lanes.get('a')).toEqual({ lane: 0, lanes: 2 });
    expect(lanes.get('b')).toEqual({ lane: 1, lanes: 2 });
  });

  it('tres citas a la misma hora usan tres columnas', () => {
    const lanes = assignLanes([
      { id: 'a', start: 0, end: 30 },
      { id: 'b', start: 0, end: 30 },
      { id: 'c', start: 0, end: 30 },
    ]);

    expect(lanes.get('a')?.lanes).toBe(3);
    expect(new Set([lanes.get('a')?.lane, lanes.get('b')?.lane, lanes.get('c')?.lane]).size).toBe(3);
  });

  it('reutiliza un carril cuando la anterior ya terminó', () => {
    const lanes = assignLanes([
      { id: 'a', start: 0, end: 60 },
      { id: 'b', start: 30, end: 90 },
      { id: 'c', start: 60, end: 120 },
    ]);

    expect(lanes.get('a')?.lane).toBe(0);
    expect(lanes.get('b')?.lane).toBe(1);
    // 'c' empieza cuando 'a' termina: puede volver al carril 0.
    expect(lanes.get('c')?.lane).toBe(0);
    expect(lanes.get('c')?.lanes).toBe(2);
  });

  it('un cluster no afecta al siguiente', () => {
    const lanes = assignLanes([
      { id: 'a', start: 0, end: 60 },
      { id: 'b', start: 30, end: 90 },
      { id: 'c', start: 200, end: 260 },
    ]);

    expect(lanes.get('c')).toEqual({ lane: 0, lanes: 1 });
  });

  it('una lista vacía no rompe nada', () => {
    expect(assignLanes([]).size).toBe(0);
  });
});

describe('detección de cruces', () => {
  it('calcula los minutos exactos de solapamiento', () => {
    const found = overlapsWith(
      { start: 630, end: 720 },
      [
        { id: 'a', start: 600, end: 660 },
        { id: 'b', start: 700, end: 760 },
      ],
    );

    expect(found).toHaveLength(2);
    expect(found[0]?.minutes).toBe(30);
    expect(found[1]?.minutes).toBe(20);
  });

  it('no cuenta citas contiguas', () => {
    const found = overlapsWith(
      { start: 600, end: 660 },
      [{ id: 'a', start: 660, end: 720 }],
    );
    expect(found).toHaveLength(0);
  });

  it('ignora la cita que se está editando', () => {
    const found = overlapsWith(
      { id: 'self', start: 600, end: 660 },
      [
        { id: 'self', start: 600, end: 660 },
        { id: 'other', start: 630, end: 690 },
      ],
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe('other');
  });

  it('ordena los cruces por hora de inicio', () => {
    const found = overlapsWith(
      { start: 600, end: 720 },
      [
        { id: 'late', start: 660, end: 700 },
        { id: 'early', start: 610, end: 650 },
      ],
    );

    expect(found.map((item) => item.id)).toEqual(['early', 'late']);
  });
});
