/* Per-station facts that are NOT in the API but are needed for ET₀.
   Key = gateway number (the "ID" shown on the dashboard).

   latitude   — degrees north (e.g. 19.57). If missing, the gateway's own latitude
                from the API is used when present, otherwise DEFAULT_LATITUDE.
                (Effect is small: anywhere in India changes ET₀ by < 2 %.)
   windHeight — height of the wind sensor above ground in metres (FAO standard: 2). */

export const DEFAULT_LATITUDE = 20; // middle of India
export const DEFAULT_WIND_HEIGHT = 2;

export const STATIONS = {
  // "2208": { latitude: 19.57, windHeight: 2 },
};
