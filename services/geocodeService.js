// services/geocodeService.js
const axios = require("axios");

/**
 * Geocode a lead based on company + city + state.
 * You can swap this to Google Maps later if you want.
 */
async function geocodeLead({ company, city, state }) {
  const queryParts = [];
  if (company) queryParts.push(company);
  if (city) queryParts.push(city);
  if (state) queryParts.push(state);

  const query = queryParts.join(", ");

  if (!query) {
    throw new Error("No location data provided for geocoding");
  }

  // Example: OpenStreetMap Nominatim (no API key needed)
  const url = "https://nominatim.openstreetmap.org/search";
  const resp = await axios.get(url, {
    params: {
      q: query,
      format: "json",
      limit: 1
    },
    headers: {
      "User-Agent": "Deli Sandwich 2.0 (BDR Tool)"
    }
  });

  const results = resp.data;
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error(`No geocode result for query: ${query}`);
  }

  const best = results[0];

  return {
    lat: parseFloat(best.lat),
    lng: parseFloat(best.lon)
  };
}

module.exports = { geocodeLead };
