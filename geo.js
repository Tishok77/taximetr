// Трекинг пробега по GPS.
// Использует navigator.geolocation.watchPosition и считает расстояние
// между последовательными точками по формуле гаверсинуса.
// Отбрасывает неточные/шумные точки, чтобы пробег не "прыгал".

const GeoTracker = (() => {
  let watchId = null;
  let lastPoint = null; // { lat, lon, t }

  const MAX_ACCURACY_M = 50;      // игнорировать точки с точностью хуже 50м
  const MAX_SPEED_MPS = 55;       // ~200 км/ч — считаем шумом/скачком GPS
  const MIN_DISTANCE_M = 5;       // игнорировать дрожание на месте

  function toRad(deg) { return (deg * Math.PI) / 180; }

  function haversineMeters(a, b) {
    const R = 6371000;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function isSupported() {
    return 'geolocation' in navigator;
  }

  function start(onDeltaKm, onError) {
    if (!isSupported()) {
      onError && onError(new Error('Геолокация не поддерживается устройством'));
      return;
    }
    if (watchId !== null) return; // уже запущен

    lastPoint = null;
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const point = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          t: pos.timestamp,
          accuracy: pos.coords.accuracy,
        };

        if (point.accuracy > MAX_ACCURACY_M) {
          return; // точка слишком неточная — пропускаем
        }

        if (lastPoint) {
          const distanceM = haversineMeters(lastPoint, point);
          const dtSec = Math.max((point.t - lastPoint.t) / 1000, 0.001);
          const speedMps = distanceM / dtSec;

          if (distanceM >= MIN_DISTANCE_M && speedMps <= MAX_SPEED_MPS) {
            onDeltaKm(distanceM / 1000);
            lastPoint = point;
          } else if (speedMps > MAX_SPEED_MPS) {
            // похоже на скачок GPS — обновляем точку отсчёта, но не считаем расстояние
            lastPoint = point;
          }
          // если distanceM < MIN_DISTANCE_M — стоим на месте, ничего не делаем и не двигаем lastPoint
        } else {
          lastPoint = point;
        }
      },
      (err) => {
        onError && onError(err);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 25000,
      }
    );
  }

  function stop() {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
      lastPoint = null;
    }
  }

  function isRunning() {
    return watchId !== null;
  }

  return { start, stop, isRunning, isSupported };
})();
