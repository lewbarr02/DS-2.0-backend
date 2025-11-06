const map = L.map('map').setView([37.8, -96], 4);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

const addLeadBtn = document.getElementById('addLeadBtn');
const leadModal = document.getElementById('leadModal');
const cancelLead = document.getElementById('cancelLead');
const leadForm = document.getElementById('leadForm');

let editingLeadId = null;
let currentMarkers = [];

addLeadBtn?.addEventListener('click', () => {
  leadModal.style.display = 'flex';
  editingLeadId = null;
  leadForm.reset();
});

cancelLead?.addEventListener('click', () => {
  leadModal.style.display = 'none';
  leadForm.reset();
  editingLeadId = null;
});

leadForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const formData = new FormData(leadForm);
  const lead = Object.fromEntries(formData.entries());

  const method = editingLeadId ? 'PUT' : 'POST';
  const endpoint = editingLeadId
    ? `http://localhost:8080/leads/${editingLeadId}`
    : 'http://localhost:8080/leads';

  try {
    const res = await fetch(endpoint, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer supersecretdelisandwich'
      },
      body: JSON.stringify(lead)
    });

    if (!res.ok) throw new Error(`Server responded with ${res.status}`);
    const savedLead = await res.json();
    console.log('✅ Lead saved:', savedLead);
    leadModal.style.display = 'none';
    leadForm.reset();
    editingLeadId = null;

    // Refresh pins
    dropAllPins();

  } catch (err) {
    console.error('❌ Save failed:', err);
    alert('❌ Failed to save lead. See console.');
  }
});

function dropAllPins() {
  currentMarkers.forEach(marker => map.removeLayer(marker));
  currentMarkers = [];

  fetch('http://localhost:8080/leads', {
    headers: { 'Authorization': 'Bearer supersecretdelisandwich' }
  })
    .then(res => res.json())
    .then(leads => {
      leads.forEach(lead => {
        if (!lead.city || !lead.state) return;

        const fullAddress = `${lead.city}, ${lead.state}`;
        fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(fullAddress)}`)
          .then(res => res.json())
          .then(results => {
            if (results.length === 0) return;

            const { lat, lon } = results[0];

            const popupContent = `
              <strong>${lead.name || 'New Lead'}</strong><br/>
              ${lead.company || ''}<br/>
              ${lead.city || ''}, ${lead.state || ''}<br/>
              <strong>Status:</strong> ${lead.status || 'Unspecified'}<br/>
              <strong>Tags:</strong> ${lead.tags || ''}<br/>
              <strong>Cadence:</strong> ${lead.cadence || lead.cadence_name || ''}<br/>
              <strong>Website:</strong> <a href="${lead.website}" target="_blank">${lead.website}</a><br/>
              <strong>Notes:</strong> ${lead.notes || ''}<br/>
              <button onclick="editLead(${lead.id})">✏️ Edit</button>
            `;

            const marker = L.marker([lat, lon]).addTo(map);
            marker.bindPopup(popupContent);
            currentMarkers.push(marker);
          });
      });
    });
}

// 🛠️ Edit Lead Modal
window.editLead = function (id) {
  fetch(`http://localhost:8080/leads/${id}`, {
    headers: { 'Authorization': 'Bearer supersecretdelisandwich' }
  })
    .then(res => res.json())
    .then(data => {
      editingLeadId = id;
      leadForm.name.value = data.name || '';
      leadForm.company.value = data.company || '';
      leadForm.city.value = data.city || '';
      leadForm.state.value = data.state || '';
      leadForm.tags.value = data.tags || '';
      leadForm.cadence_name.value = data.cadence_name || data.cadence || '';
      leadForm.website.value = data.website || '';
      leadForm.status.value = data.status || '';
      leadForm.notes.value = data.notes || '';

      leadModal.style.display = 'flex';
    })
    .catch(err => {
      console.error('❌ Failed to load lead for editing:', err);
      alert('❌ Error loading lead');
    });
};

// Load pins on startup
dropAllPins();