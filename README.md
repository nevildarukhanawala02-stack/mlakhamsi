# M Lakhamsi Industries — Website

Static corporate website for M Lakhamsi Industries Limited.
Positioning: *India's most accountable agri-export partner — proof over claim.*

## Pages
```
index.html        Homepage
about.html         About Us
products.html       Products (50 commodities across 8 categories)
quality.html        Quality & Compliance
investors.html       Investors (structured filings hub)
csr.html              CSR
contact.html           Contact (form + real office details)
reports.html            Market Reports (template, placeholder cards)
social.html               Social (built but UNLINKED — hidden until feeds are fresh, per brand guide)
```

## Structure
```
images/            All visual assets
images/products/    50 product photos (run fetch_product_images.sh to populate)
server.js          Minimal Express static server (for Railway)
package.json       Start script + dependency
fetch_product_images.sh   One-time downloader for product images
```

## Notes
- Google Translate: custom 6-language flag strip, identical implementation across all pages — do not modify.
- Image paths are absolute (`/images/...`) — correct for root-domain hosting (Railway).
- Social page exists on disk but is intentionally not linked in nav/footer anywhere, per the brand guide's launch condition (both LinkedIn and Twitter/X must have posts within 30 days first).
- Contact page: trade email is a placeholder pending client confirmation; investor email (equity@m.lakhamsi.com) is real, sourced from the live Investor Relations page.
- Investors page: all document links are real, live filings pulled from the current m.lakhamsi.com Investor Relations page.

## Run locally
```bash
npm install
npm start
# open http://localhost:3000
```

## Deploy (Railway)
Railway auto-detects Node, runs `npm install` then `npm start`. No environment variables required.
