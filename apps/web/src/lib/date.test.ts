import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayNumber,
  durationMinutes,
  humanDuration,
  localDayOf,
  localTime,
  minutesOfDay,
  minutesToTime,
  startOfWeek,
  timeToMinutes,
  today,
  weekDays,
  weekday,
} from './date';

describe('fechas de la agenda', () => {
  it('hoy tiene formato YYYY-MM-DD', () => {
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('suma días cruzando mes y año', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
  });

  it('la semana empieza en lunes', () => {
    // 2026-11-02 es lunes.
    expect(weekday('2026-11-02')).toBe(1);
    expect(startOfWeek('2026-11-02')).toBe('2026-11-02');
    expect(startOfWeek('2026-11-08')).toBe('2026-11-02');
    expect(startOfWeek('2026-11-04')).toBe('2026-11-02');
  });

  it('devuelve los siete días de la semana', () => {
    const days = weekDays('2026-11-04');
    expect(days).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
    ]);
  });

  it('el domingo pertenece a la semana anterior', () => {
    expect(startOfWeek('2026-11-08')).toBe('2026-11-02');
    expect(weekDays('2026-11-08')[0]).toBe('2026-11-02');
  });

  it('convierte horas a minutos y viceversa', () => {
    expect(timeToMinutes('09:30')).toBe(570);
    expect(timeToMinutes('00:00')).toBe(0);
    expect(minutesToTime(570)).toBe('09:30');
    expect(minutesToTime(0)).toBe('00:00');
  });

  it('lee la hora local que devuelve la API', () => {
    expect(localTime('2026-11-02T10:30:00')).toBe('10:30');
    expect(localDayOf('2026-11-02T10:30:00')).toBe('2026-11-02');
    expect(minutesOfDay('2026-11-02T10:30:00')).toBe(630);
  });

  it('calcula la duración de una cita', () => {
    expect(
      durationMinutes('2026-11-02T10:00:00', '2026-11-02T11:30:00'),
    ).toBe(90);
    expect(
      durationMinutes('2026-11-02T10:00:00', '2026-11-02T10:30:00'),
    ).toBe(30);
  });

  it('escribe duraciones legibles', () => {
    expect(humanDuration(30)).toBe('30 min');
    expect(humanDuration(60)).toBe('1 h');
    expect(humanDuration(90)).toBe('1 h 30 min');
  });

  it('el número de día no lleva cero a la izquierda', () => {
    expect(dayNumber('2026-11-02')).toBe('2');
    expect(dayNumber('2026-11-15')).toBe('15');
  });
});
