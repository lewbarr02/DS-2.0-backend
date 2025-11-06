// map.js

// Create the map instance centered on USA
const map = L.map("map").setView([39.5, -98.35], 4); // Approximate center of the U.S.

// Add OpenStreetMap tile layer
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  maxZoom: 18,
}).addTo(map);

// Load custom icon colors
const iconColors = {
  Converted: "green",
  Hot: "red",
  Warm: "orange",
  Cold: "blue",
  Research: "grey",
  "Follow-Up": "violet",
  Unspecified: "gold"
};

function getMarkerIcon(status) {
  const color = iconColors[status] || "gold";
  return L.icon({
    iconUrl: `./icons/marker-icon-${color}.png`,
    shadowUrl: "./icons/marker-shadow.png",
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34],
    shadowSize: [41, 41],
  });
}

// 🔌 This is called from leads.js after leadData is fetched
function renderLeadsOnMap(leads) {
  leads.forEach((lead) => {
    const { city, state, company, name, status, tags } = lead;

    // If no city/state, skip
    if (!city || !state) return;

    // Use simple geocoding (temporary) — fallback to static centers for now
    fetch(`https://nominatim.openstreetmap.org/search?city=${encodeURIComponent(city)}&state=${encodeURIComponent(state)}&country=USA&format=json`)
      .then((res) => res.json())
      .then((data) => {
        if (!data.length) return;

        const { lat, lon } = data[0];
        const marker = L.marker([lat, lon], {
          icon: getMarkerIcon(status),
        }).addTo(map);

        marker.bindPopup(`
          <strong>${company || "No Company"}</strong><br>
          Contact: ${name || "N/A"}<br>
          Status: ${status || "N/A"}<br>
          Tags: ${tags || "None"}
        `);
      })
      .catch((err) => console.warn("Geocode fail:", city, state, err));
  });
}
