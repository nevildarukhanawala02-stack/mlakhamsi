// Works out a document's REPORT date from its file name, so the order on the
// website follows the report itself and not the day it was uploaded.
//   "Board Meeting Intimation-12.11.2025.pdf"      -> 2025-11-12   (exact date)
//   "MGT-7 FY 24-25.pdf"                           -> 2025-03-31   (financial year end)
//   "Indian Sesame Markets - October 2026.pdf"     -> 2026-10-31   (month end, unless the
//                                                      typed date is already in that month)
// A date typed in the form is only used when the file name has none.

const MONTHS = { jan:1, january:1, feb:2, february:2, mar:3, march:3, apr:4, april:4, may:5,
  jun:6, june:6, jul:7, july:7, aug:8, august:8, sep:9, sept:9, september:9,
  oct:10, october:10, nov:11, november:11, dec:12, december:12 };

const pad = n => String(n).padStart(2, '0');
const iso = (y, m, d) => y + '-' + pad(m) + '-' + pad(d);
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function validIso(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const [y, m, d] = s.split('-').map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= lastDay(y, m) && y >= 1990;
}

function inferDocDate(fileName, typedDate, today) {
  const name = String(fileName || '').replace(/\.pdf$/i, '');
  const now = today || new Date();
  const limit = new Date(now.getTime() + 400 * 86400000).toISOString().slice(0, 10);
  const typed = validIso((typedDate || '').trim()) ? typedDate.trim() : null;
  const ok = (date, source) => (date <= limit ? { date, source } : { date: null, source: null, error: 'future' });

  // 1. exact day: 12.11.2025 / 12-11-2025 / 12_11_2025
  let m = name.match(/(?<!\d)(\d{1,2})[.\-_](\d{1,2})[.\-_](20\d{2})(?!\d)/);
  if (m) {
    const d = +m[1], mo = +m[2], y = +m[3];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= lastDay(y, mo)) return ok(iso(y, mo, d), 'file name');
  }
  // 1b. compact ddmmyyyy: Financial-30052024
  m = name.match(/(?<!\d)(\d{2})(\d{2})(20\d{2})(?!\d)/);
  if (m) {
    const dd = +m[1], mo = +m[2], y = +m[3];
    if (mo >= 1 && mo <= 12 && dd >= 1 && dd <= lastDay(y, mo)) return ok(iso(y, mo, dd), 'file name');
  }
  // 1c. month, day, year: June-30-2023 / June 30, 2023
  m = name.match(/(?<![a-z])(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)(?![a-z])[\s._\-]+(\d{1,2})(?:st|nd|rd|th)?[\s._,\-]+(20\d{2})(?!\d)/i);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()], dd = +m[2], y = +m[3];
    if (dd >= 1 && dd <= lastDay(y, mo)) return ok(iso(y, mo, dd), 'file name');
  }
  // 2. financial year: FY 24-25 / FY2024-25 -> 31 March of the end year
  m = name.match(/FY[\s._\-]*(\d{2,4})[\s._\-]+(\d{2,4})(?!\d)/i);
  if (m) {
    let y = +m[2]; if (y < 100) y += 2000;
    if (y >= 2000 && y <= 2100) return ok(iso(y, 3, 31), 'file name (financial year end)');
  }
  // 2b. consecutive year pair: Annual-Report-2025-26 -> 31 March 2026
  m = name.match(/(?<!\d)(20\d{2})[\s._\-\/](\d{2})(?!\d)/);
  if (m && +m[2] === (+m[1] + 1) % 100) return ok(iso(+m[1] + 1, 3, 31), 'file name (financial year end)');
  // 3. month + year: "October 2026", "Sept 2026", "Jan2026", "May-June 2024" (last month named)
  const re = /(?<![a-z])(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)(?![a-z])[\s._\-]*(20\d{2})(?!\d)/gi;
  let last = null, mm;
  while ((mm = re.exec(name)) !== null) last = mm;
  if (last) {
    const mo = MONTHS[last[1].toLowerCase()], y = +last[2];
    if (typed && typed.slice(0, 7) === y + '-' + pad(mo)) return ok(typed, 'form (matches file name month)');
    return ok(iso(y, mo, lastDay(y, mo)), 'file name (month end)');
  }
  // 4. nothing in the file name: use the typed date
  if (typed) return ok(typed, 'form');
  return { date: null, source: null, error: 'none' };
}

module.exports = { inferDocDate, validIso };
