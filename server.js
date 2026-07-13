// Minimal static file server for the M Lakhamsi website.
// Serves index.html, about.html and the /images folder from the project root.
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000; // Railway injects PORT

// Serve every static file (HTML, images) from this folder.
// This makes absolute paths like /images/logo.png resolve correctly.
app.use(express.static(__dirname, { extensions: ['html'] }));

// Explicit friendly routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/about', (req, res) => res.sendFile(path.join(__dirname, 'about.html')));

// Fallback: anything unknown -> homepage (keeps links from 404ing during review)
app.use((req, res) => res.status(200).sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => {
  console.log(`M Lakhamsi site running on port ${PORT}`);
});
