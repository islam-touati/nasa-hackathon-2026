export function frpClass(value) {
  if (!Number.isFinite(value) || value < 0) return { css: 'unknown', label: 'FRP unavailable' };
  if (value < 10) return { css: 'low', label: 'FRP below 10 MW' };
  if (value < 50) return { css: 'medium', label: 'FRP from 10 to less than 50 MW' };
  return { css: 'high', label: 'FRP at least 50 MW' };
}

export function utcForecastTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 16) === value ? date : null;
}

export function weatherRows(forecast, now = Date.now()) {
  if (!forecast?.hourly || !Array.isArray(forecast.hourly.time)) throw new Error('Weather times unavailable.');
  if (forecast.utc_offset_seconds !== 0) throw new Error('Weather UTC timezone unavailable or unexpected.');
  const units = forecast.hourly_units;
  if (!units || units.temperature_2m !== '°C' || units.relative_humidity_2m !== '%' ||
      units.precipitation !== 'mm' || units.wind_speed_10m !== 'km/h' ||
      units.wind_gusts_10m !== 'km/h' || units.wind_direction_10m !== '°') {
    throw new Error('Weather units unexpected or unavailable.');
  }
  const hourly = forecast.hourly;
  return hourly.time.flatMap((time, index) => {
    const date = utcForecastTime(time);
    if (!date) throw new Error('Invalid UTC weather time.');
    if (date.getTime() < now || date.getTime() > now + 72 * 3600000) return [];
    const value = (key) => Number.isFinite(hourly[key]?.[index]) ? hourly[key][index] : null;
    const speed = value('wind_speed_10m');
    const gust = value('wind_gusts_10m');
    const humidity = value('relative_humidity_2m');
    const temperature = value('temperature_2m');
    const rain = value('precipitation');
    const direction = value('wind_direction_10m');
    const flags = [];
    if (speed !== null && speed >= 40) flags.push('Wind ≥ 40 km/h');
    if (gust !== null && gust >= 60) flags.push('Gusts ≥ 60 km/h');
    if (humidity !== null && humidity <= 30) flags.push('Humidity ≤ 30 %');
    if (temperature !== null && temperature >= 35) flags.push('Temperature ≥ 35 °C');
    return [{ time, speed, gust, humidity, temperature, rain, direction, flags,
      incomplete: [speed, gust, humidity, temperature, rain, direction].some((item) => item === null) }];
  });
}
