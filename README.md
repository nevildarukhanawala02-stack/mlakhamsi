# M Lakhamsi Industries — Website

Static corporate website (Home + About Us) for M Lakhamsi Industries Limited.
Positioning: *India's most accountable agri-export partner — proof over claim.*

## Structure
```
index.html        Homepage
about.html        About Us page
images/           All visual assets (logo, hero/section backgrounds, product photos, cert seals)
server.js         Minimal Express static server (for Railway)
package.json      Start script + dependency
```

## Tech
- Pure static HTML with inline CSS.
- Fonts (Playfair Display + Inter) and Tabler Icons load via CDN.
- Google Translate integrated via a custom 6-language flag strip in the header.
- Image paths are absolute (`/images/...`) — correct for root-domain hosting.

## Run locally
```bash
npm install
npm start
# open http://localhost:3000
```

## Deploy (Railway)
Railway auto-detects Node, runs `npm install` then `npm start`.
No environment variables required.
